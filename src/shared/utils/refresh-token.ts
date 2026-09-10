import { generateSecureToken, hashSecureToken } from './secure-token';

/**
 * Wrapper tipis di atas `secure-token.ts` — nama fungsi `*RefreshToken`
 * dipertahankan (bukan langsung memakai `generateSecureToken` di
 * pemanggilnya) supaya kode yang sudah ada (`AuthService`, test yang
 * meng-`jest.mock` path file ini) tidak perlu berubah sama sekali.
 * Lihat `secure-token.ts` untuk penjelasan pola keamanannya.
 */
export function generateRefreshToken(): string {
  return generateSecureToken();
}

export function hashRefreshToken(token: string): string {
  return hashSecureToken(token);
}
