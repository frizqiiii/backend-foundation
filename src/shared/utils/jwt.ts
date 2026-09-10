import { randomUUID } from 'crypto';
import type { SignOptions, VerifyOptions } from 'jsonwebtoken';
import jwt from 'jsonwebtoken';
import type { RoleName } from '../types/role';
import { env } from '../config/env';

/**
 * Algorithm DIPIN eksplisit ke HS256 di SETIAP `jwt.sign`/`jwt.verify`
 * di file ini (bukan dibiarkan default library) — pertahanan berlapis
 * terhadap algorithm confusion attack (mis. token dengan header
 * `alg: RS256`/`alg: none` yang dipalsukan dicoba diverifikasi dengan
 * cara yang tidak diduga). Saat ini aplikasi ini hanya pernah memakai
 * secret simetris (`JWT_SECRET` sebagai string HMAC), jadi risikonya
 * sudah rendah tanpa ini — tapi eksplisit di sini murah dan menutup
 * celah itu SEPENUHNYA, sesuai rekomendasi OWASP ASVS, alih-alih
 * mengandalkan library tidak pernah salah pilih algoritma sendiri.
 */
const JWT_ALGORITHM = 'HS256' as const;
const JWT_VERIFY_OPTIONS: VerifyOptions = { algorithms: [JWT_ALGORITHM] };

/**
 * Payload yang dibawa access token. `id`/`email`/`role` disisipkan
 * secara sadar (role untuk RBAC stateless — lihat catatan trade-off
 * di bawah). `jti` (JWT ID) dan `exp` SELALU ada setelah `verify()` —
 * `jti` dipakai untuk blacklist (lihat `BlacklistedToken` di skema),
 * `exp` dipakai saat logout untuk menghitung berapa lama entri
 * blacklist perlu disimpan (tidak perlu lebih lama dari umur asli
 * token yang bersangkutan).
 */
export interface SignableJwtPayload {
  id: string;
  email: string;
  role: RoleName;
}

export interface JwtPayload extends SignableJwtPayload {
  jti: string;
  exp: number;
}

/**
 * Payload token MFA CHALLENGE (Phase 12) — diterbitkan `AuthService.login`
 * ketika kredensial password benar TAPI `user.mfaEnabled === true`,
 * SEBELUM access/refresh token sungguhan diterbitkan. Bertipe TERPISAH
 * dari `JwtPayload` (access token) SECARA SENGAJA — kalau strukturnya
 * sama, token challenge ini (yang sengaja tidak membawa hak akses apa
 * pun) berisiko diterima keliru oleh `authMiddleware` sebagai access
 * token biasa. Klaim `type: 'mfa_challenge'` adalah penanda yang
 * diperiksa eksplisit di `verifyMfaChallenge` untuk mencegah itu.
 */
export interface MfaChallengePayload {
  type: 'mfa_challenge';
  userId: string;
}

/** Umur token challenge SENGAJA pendek — cukup untuk user membuka
 * authenticator app & mengetik kode 6 digit, tidak lebih. */
const MFA_CHALLENGE_EXPIRES_IN = '5m';

/**
 * Helper JWT terpusat — dipakai oleh Service (saat sign, ketika login)
 * dan Middleware (saat verify, di setiap request ke rute terproteksi).
 * Memusatkan logic ini mencegah duplikasi opsi (secret, algorithm) di
 * dua tempat berbeda.
 */
export const jwtHelper = {
  sign(payload: SignableJwtPayload): string {
    const options: SignOptions = {
      expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
      algorithm: JWT_ALGORITHM,
      // `jwtid` mengisi klaim standar `jti` secara otomatis — dipakai
      // sebagai kunci unik untuk blacklist token ini kalau perlu
      // di-revoke sebelum masa berlakunya habis (mis. saat logout).
      jwtid: randomUUID(),
    };
    return jwt.sign(payload, env.JWT_SECRET, options);
  },

  verify(token: string): JwtPayload {
    try {
      return jwt.verify(token, env.JWT_SECRET, JWT_VERIFY_OPTIONS) as JwtPayload;
    } catch (error) {
      // Fallback rotasi secret (Phase 5) — HANYA dicoba kalau
      // `JWT_SECRET_PREVIOUS` benar-benar diisi (kosong secara default,
      // di luar masa transisi rotasi). Kegagalan verifikasi terhadap
      // secret AKTIF adalah kasus paling umum (token memang tidak
      // valid/kedaluwarsa) — secret lama hanya dicoba sebagai upaya
      // terakhir, bukan jalur utama.
      if (!env.JWT_SECRET_PREVIOUS) {
        throw error;
      }
      return jwt.verify(token, env.JWT_SECRET_PREVIOUS, JWT_VERIFY_OPTIONS) as JwtPayload;
    }
  },

  /**
   * Menandatangani token challenge MFA — lihat komentar lengkap di
   * `MfaChallengePayload`. TIDAK memakai `jwtid`/blacklist seperti
   * access token: umurnya sudah sangat pendek (5 menit) dan sekali
   * dipakai (`AuthService.verifyMfaLogin` langsung menukarnya dengan
   * access/refresh token sungguhan), jadi mekanisme revoke terpisah
   * tidak sepadan dengan kompleksitasnya.
   */
  signMfaChallenge(userId: string): string {
    const payload: MfaChallengePayload = { type: 'mfa_challenge', userId };
    return jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: MFA_CHALLENGE_EXPIRES_IN,
      algorithm: JWT_ALGORITHM,
    });
  },

  /**
   * Melempar `UnauthorizedError`-compatible error (lewat `jwt.verify`
   * bawaan) untuk token yang kedaluwarsa/tidak valid — DAN untuk token
   * yang valid tapi klaim `type`-nya BUKAN `'mfa_challenge'` (mis.
   * access token biasa yang dicoba dipakai di endpoint verifikasi MFA
   * login), supaya kedua kegagalan itu diperlakukan sama oleh
   * pemanggil (lihat `AuthService.verifyMfaLogin`).
   */
  verifyMfaChallenge(token: string): MfaChallengePayload {
    const payload = jwt.verify(token, env.JWT_SECRET, JWT_VERIFY_OPTIONS) as MfaChallengePayload;
    if (payload.type !== 'mfa_challenge') {
      throw new Error('Token bukan token MFA challenge yang valid');
    }
    return payload;
  },
};
