import { env } from '../config/env';

/**
 * Fase 2 (Kelompok 2, item 2.11 — rate limit per-tier/plan).
 *
 * Sebelum item ini, kuota rate limit berupa SATU angka flat untuk
 * semua tenant (1000 request/15 menit per tenant, lihat
 * `tenantRateLimiter` di `app.ts`) dan SATU angka flat untuk semua API
 * key (`API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE`, lihat
 * `api-key-gateway.ts`). Modul ini adalah SATU-SATUNYA tempat yang
 * memetakan paket layanan (`Tenant.plan`) ke angka kuota konkret —
 * dua titik penegakan (limiter per-tenant & gateway per-API-key)
 * sama-sama membaca dari sini, jadi mengubah angka sebuah tier cukup
 * di satu tempat ini.
 *
 * SENGAJA tidak mengimpor tipe apa pun dari `@prisma/client`:
 * `TenantPlanName` di bawah didefinisikan sendiri (union literal
 * yang HARUS identik dengan `enum TenantPlan` di `schema.prisma` —
 * tambah member baru di KEDUA tempat). Alasannya dua: (1) modul ini
 * tetap bisa dikompilasi/dites di environment yang belum menjalankan
 * `prisma generate`, (2) `TenantContextValue` (`shared/tenant`) dan
 * `api-key-gateway.ts` membacanya tanpa menarik dependensi ke Prisma
 * Client (pola sama dengan `OAuthProviderName`/`RoleName`).
 */
export type TenantPlanName = 'FREE' | 'PRO' | 'ENTERPRISE';

export interface RateLimitTier {
  /** Kuota gabungan SATU tenant (semua user/IP/key-nya) per jendela 15 menit. */
  tenantRequestsPer15Min: number;
  /** Kuota SATU API key partner per menit. */
  apiKeyRequestsPerMinute: number;
}

/**
 * Tier yang dipakai kalau plan tidak diketahui: tenant context tidak
 * aktif, API key tanpa tenant (masa transisi Phase 11), data cache
 * lama yang belum punya field `plan`, atau nilai plan tak dikenal.
 * `PRO` (bukan `FREE`) supaya perilaku fallback = perilaku LAMA
 * sebelum item 2.11 (backward compatible) — lebih baik melonggarkan
 * sesaat daripada tiba-tiba memblokir traffic sah karena data yang
 * tidak lengkap.
 */
export const DEFAULT_TENANT_PLAN: TenantPlanName = 'PRO';

/**
 * Dibaca LAZY lewat fungsi (bukan konstanta modul-level) karena angka
 * `apiKeyRequestsPerMinute` untuk `PRO` mengikuti
 * `API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE` — env var yang sudah ada
 * sejak item 2.10 dan SENGAJA dipertahankan artinya (sekarang = kuota
 * tier PRO, yaitu tier default) supaya deployment yang sudah
 * mengaturnya tidak berubah perilakunya.
 */
function buildTiers(): Record<TenantPlanName, RateLimitTier> {
  return {
    // Angka PRO = angka flat LAMA (backward compatible, lihat
    // `DEFAULT_TENANT_PLAN`).
    // FREE SENGAJA di bawah limit per-IP `generalRateLimiter` (300/15 menit,
    // `app.ts`): limiter per-IP berjalan LEBIH DULU dan berlaku untuk semua
    // plan, jadi kuota per-tenant yang >= 300 tidak akan pernah terasa dari
    // satu IP. 200 membuat tier FREE benar-benar membatasi walau semua
    // request datang dari satu IP.
    FREE: { tenantRequestsPer15Min: 200, apiKeyRequestsPerMinute: 60 },
    PRO: {
      tenantRequestsPer15Min: 1000,
      apiKeyRequestsPerMinute: env.API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE,
    },
    ENTERPRISE: { tenantRequestsPer15Min: 5000, apiKeyRequestsPerMinute: 1200 },
  };
}

export function isTenantPlanName(value: unknown): value is TenantPlanName {
  return value === 'FREE' || value === 'PRO' || value === 'ENTERPRISE';
}

/**
 * Plan tak dikenal/kosong (`null`, `undefined`, string sembarang dari
 * cache lama) TIDAK melempar error — jatuh ke `DEFAULT_TENANT_PLAN`.
 * Rate limiting berjalan di hot path SETIAP request; data plan yang
 * rusak tidak boleh menjadi alasan request gagal.
 */
export function getRateLimitTier(plan: unknown): RateLimitTier {
  const resolved: TenantPlanName = isTenantPlanName(plan) ? plan : DEFAULT_TENANT_PLAN;
  return buildTiers()[resolved];
}
