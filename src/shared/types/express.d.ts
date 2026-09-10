/**
 * Type augmentation untuk Express `Request`.
 * Memberitahu TypeScript compiler bahwa `req.user` adalah properti
 * yang sah (diisi oleh `authMiddleware`), sehingga tidak dianggap
 * error/undefined saat diakses di Controller pada rute terproteksi.
 *
 * File ini tidak perlu di-import di mana pun — cukup ikut ter-include
 * oleh `tsconfig.json` (folder src/**) agar declaration merging aktif
 * secara global.
 */
export {};

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: import('./role').RoleName;
        /** JWT ID — dipakai untuk blacklist token ini saat logout. Untuk
         * request yang diautentikasi lewat API key (Phase 12), diisi
         * `api-key:<id>` sebagai placeholder — konsep "blacklist"
         * tidak berlaku untuk API key (pencabutannya lewat
         * `ApiKey.revokedAt`, dicek langsung di `ApiKeyService.authenticate`). */
        jti: string;
        /** Unix timestamp (detik) kapan access token ini kedaluwarsa. */
        exp: number;
        /**
         * Phase 12 — HANYA terisi kalau request diautentikasi lewat API
         * key (bukan JWT biasa). Kalau ada, `requirePermission`
         * mewajibkan permission yang diminta ADA di scope ini JUGA
         * (bukan cuma di permission role) — lihat komentar lengkap di
         * `permission.middleware.ts`.
         */
        apiKeyScopes?: string[];
      };
    }
  }
}
