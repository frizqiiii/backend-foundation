import type { Request } from 'express';

/**
 * Prefix `jti` yang dipasang `authMiddleware` pada `req.user` untuk
 * request yang terautentikasi lewat API key (`api-key:<apiKeyId>`,
 * lihat `authenticateWithApiKey`). Token JWT sungguhan memakai UUID
 * sebagai `jti`, jadi prefix ini tidak ambigu — dan karena `req.user`
 * hanya diisi SETELAH key terbukti valid DAN kuota per-key-nya lolos,
 * prefix ini sekaligus menandai "request ini sudah diautentikasi
 * penuh lewat API key".
 *
 * Dipisah ke modul sendiri (bukan konstanta lokal di
 * `auth.middleware.ts`) supaya `generalRateLimiter` (`app.ts`) dan
 * `authMiddleware` membaca SATU definisi yang sama — kalau format
 * `jti` berubah, keduanya ikut berubah, bukan diam-diam tidak sinkron.
 */
export const API_KEY_JTI_PREFIX = 'api-key:';

/**
 * Fase 2 (temuan T1) — true kalau request ini sudah diautentikasi
 * PENUH lewat API key yang valid dan masih dalam kuota per-key-nya.
 *
 * SENGAJA membaca hasil autentikasi (`req.user`), BUKAN sekadar
 * header `Authorization: Bearer bfk_...`: header itu bisa ditempel
 * siapa pun ke request apa pun (termasuk endpoint publik yang tidak
 * pernah menjalankan `authMiddleware`), jadi tidak boleh dipercaya
 * sebagai dasar pembebasan dari batas per-IP.
 */
export function isApiKeyAuthenticated(req: Request): boolean {
  const jti = req.user?.jti;
  return typeof jti === 'string' && jti.startsWith(API_KEY_JTI_PREFIX);
}
