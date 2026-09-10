import { z } from 'zod';

export const confirmMfaSetupSchema = z.object({
  code: z
    .string()
    .length(6, 'Kode harus 6 digit')
    .regex(/^\d{6}$/, 'Kode harus berupa 6 angka'),
});
export type ConfirmMfaSetupDto = z.infer<typeof confirmMfaSetupSchema>;

export const disableMfaSchema = z.object({
  // Re-autentikasi wajib pakai PASSWORD (bukan kode TOTP) — kalau
  // user kehilangan akses ke authenticator app-nya (justru skenario
  // paling mungkin dia ingin menonaktifkan MFA), mewajibkan kode TOTP
  // untuk menonaktifkan MFA akan membuatnya terkunci permanen dari
  // aksi ini juga.
  password: z.string().min(1, 'Password wajib diisi'),
});
export type DisableMfaDto = z.infer<typeof disableMfaSchema>;

/**
 * `code` menerima TOTP 6-digit MAUPUN recovery code (format
 * `XXXXX-XXXXX`, lebih panjang) — SENGAJA satu field, bukan dua
 * endpoint terpisah, supaya UI login tidak perlu tahu lebih dulu jenis
 * kode apa yang akan diketik user (lihat `MfaService.verifyCode` yang
 * mencoba keduanya).
 */
export const verifyMfaLoginSchema = z.object({
  challengeToken: z.string().min(1, 'Challenge token wajib diisi'),
  code: z.string().min(6, 'Kode tidak valid').max(20, 'Kode tidak valid'),
});
export type VerifyMfaLoginDto = z.infer<typeof verifyMfaLoginSchema>;

export interface MfaSetupResponseDto {
  secret: string;
  otpauthUrl: string;
}

export interface MfaRecoveryCodesResponseDto {
  recoveryCodes: string[];
}

/**
 * Dikembalikan `AuthService.login` MENGGANTIKAN `AuthResponseDto`
 * ketika kredensial password benar TAPI `user.mfaEnabled === true` —
 * BELUM ada access/refresh token sungguhan di titik ini. Client harus
 * memanggil `/auth/mfa/verify-login` dengan `challengeToken` ini +
 * kode TOTP/recovery untuk menyelesaikan login.
 */
export interface MfaRequiredResponseDto {
  mfaRequired: true;
  challengeToken: string;
}
