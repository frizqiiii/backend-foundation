import { randomBytes, createHash } from 'crypto';

/**
 * Primitif token acak + hash generik — dipakai bersama oleh refresh
 * token, verifikasi email, dan reset password. Ketiganya punya pola
 * keamanan identik: terbitkan string acak, kirim/berikan yang MENTAH
 * ke client, simpan HANYA hash SHA-256-nya di database (pola yang
 * sama seperti menyimpan password — kebocoran database tidak otomatis
 * berarti kebocoran token).
 */
const TOKEN_BYTES = 64;

export function generateSecureToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSecureToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
