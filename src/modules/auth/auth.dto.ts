import { z } from 'zod';
import type { UserResponseDto } from '../users/user.dto';

/**
 * Password policy (Phase 5 — Security Hardening). Sebelumnya HANYA
 * `min(8)` — tidak ada syarat kompleksitas sama sekali, jauh di bawah
 * baseline OWASP untuk password baru. Dipusatkan di SATU schema
 * (dipakai ulang oleh `registerSchema` DAN `resetPasswordSchema`)
 * supaya kedua jalur pembuatan password (registrasi & reset) tidak
 * bisa diam-diam berbeda aturan.
 *
 * SENGAJA tidak mewajibkan karakter spesial (`!@#$...`) — NIST
 * SP 800-63B (pedoman kontemporer, beda dari aturan kompleksitas
 * "wajib huruf besar+kecil+angka+simbol" era 2000-an) menyarankan
 * panjang lebih diutamakan daripada komposisi karakter yang rumit;
 * kombinasi huruf besar+kecil+angka sudah menaikkan entropi secara
 * berarti tanpa mendorong pengguna ke pola predictable seperti
 * "Password1!".
 */
export const passwordPolicySchema = z
  .string()
  .min(8, 'Password minimal 8 karakter')
  .refine((value) => /[a-z]/.test(value), 'Password harus mengandung huruf kecil')
  .refine((value) => /[A-Z]/.test(value), 'Password harus mengandung huruf besar')
  .refine((value) => /[0-9]/.test(value), 'Password harus mengandung angka');

export const registerSchema = z.object({
  name: z.string().min(2, 'Nama minimal 2 karakter'),
  email: z.string().email('Format email tidak valid'),
  password: passwordPolicySchema,
});

export type RegisterDto = z.infer<typeof registerSchema>;

/**
 * Sengaja tidak menduplikasi aturan `min(8)` dari registrasi — pesan
 * error login tidak boleh membocorkan aturan kompleksitas password
 * (praktik keamanan umum), cukup pastikan field terisi.
 */
export const loginSchema = z.object({
  email: z.string().email('Format email tidak valid'),
  password: z.string().min(1, 'Password wajib diisi'),
});

export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken wajib diisi'),
});

export type RefreshDto = z.infer<typeof refreshSchema>;

export const logoutSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken wajib diisi'),
});

export type LogoutDto = z.infer<typeof logoutSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'token wajib diisi'),
});

export type VerifyEmailDto = z.infer<typeof verifyEmailSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email('Format email tidak valid'),
});

export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'token wajib diisi'),
  newPassword: passwordPolicySchema,
});

export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

export const googleLoginSchema = z.object({
  idToken: z.string().min(1, 'idToken wajib diisi'),
});

export type GoogleLoginDto = z.infer<typeof googleLoginSchema>;

export const githubLoginSchema = z.object({
  code: z.string().min(1, 'code wajib diisi'),
});

export type GithubLoginDto = z.infer<typeof githubLoginSchema>;

export interface AuthResponseDto {
  accessToken: string;
  refreshToken: string;
  user: UserResponseDto;
}

export interface RefreshResponseDto {
  accessToken: string;
  refreshToken: string;
}

/**
 * Representasi PUBLIK satu sesi/device (baris `RefreshToken`) —
 * SENGAJA TIDAK menyertakan `tokenHash` sama sekali, meski sudah
 * berupa hash (bukan token mentah). Tidak ada alasan sah field itu
 * perlu sampai ke klien; mengeksposnya hanya menambah luas permukaan
 * serangan tanpa manfaat fungsional apa pun bagi pengguna.
 */
export interface SessionDto {
  id: string;
  userAgent: string | null;
  /** Hasil parse `userAgent` (lihat `shared/utils/user-agent.ts`) — `null` kalau `userAgent` tidak ada/tidak dikenali. */
  browser: string | null;
  operatingSystem: string | null;
  /** Label siap-tampil, mis. "Chrome di Windows". */
  deviceName: string;
  ipAddress: string | null;
  createdAt: Date;
  /**
   * Perkiraan "terakhir aktif" — SENGAJA dihitung ulang dari
   * `createdAt` baris token yang sedang aktif saat ini (dievaluasi di
   * `AuthService.listSessions`), BUKAN kolom database tersendiri yang
   * di-`UPDATE` di setiap request. Menulis ke tabel `refresh_tokens`
   * pada SETIAP request terautentikasi (bukan hanya saat
   * login/refresh) akan membebani database secara signifikan untuk
   * manfaat presisi yang marjinal — proxy ini cukup akurat karena
   * baris berganti tiap kali access token di-refresh (siklus pendek).
   */
  lastActive: Date;
  expiresAt: Date;
  /** `true` untuk sesi yang sedang dipakai membuat request `GET /auth/sessions` ini sendiri — dibedakan di Service lewat `currentRefreshTokenHash`, BUKAN ditebak di Controller. */
  isCurrent: boolean;
}

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQueryDto = z.infer<typeof paginationQuerySchema>;

export interface LoginHistoryEntryDto {
  action: 'LOGIN' | 'LOGOUT';
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}
