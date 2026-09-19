/**
 * Registry terpusat untuk nama key cache — dipakai bersama oleh
 * modul yang MEMBACA cache (mis. `UserService`) dan modul yang harus
 * MENGINVALIDASI-nya dari tempat lain (mis. `AuthService` saat
 * `verifyEmail`/`resetPassword` mengubah data user). Kalau setiap
 * file menulis nama key-nya sendiri-sendiri sebagai string literal,
 * risiko besar: satu sisi salah ketik atau lupa update format,
 * cache jadi tidak pernah ter-invalidasi dengan benar.
 */
export const cacheKeys = {
  userProfile: (userId: string): string => `cache:user:profile:${userId}`,
  /**
   * Phase 8 — listing Products sekarang dipaginasi & bisa difilter,
   * jadi butuh pola yang SAMA seperti `eventsList`/`eventsListPattern`
   * di bawah: satu key per kombinasi query, dihapus sekaligus lewat
   * `invalidateByPattern` saat ada produk yang dibuat/di-upgrade.
   */
  productsListPattern: (): string => 'cache:products:list:*',
  productsList: (queryKey: string): string => `cache:products:list:${queryKey}`,
  /**
   * Listing Events punya banyak variasi (page/limit/filter/search) —
   * setiap kombinasi query dapat key sendiri, tapi SEMUANYA berbagi
   * prefix yang sama supaya bisa dihapus sekaligus lewat
   * `invalidateByPattern` saat ada event yang dibuat/diubah/dihapus.
   */
  eventsListPattern: (): string => 'cache:events:list:*',
  eventsList: (queryKey: string): string => `cache:events:list:${queryKey}`,
  /** Phase 16 upgrade — lihat `FeatureFlagService.isEnabled`. */
  featureFlag: (key: string): string => `cache:feature-flag:${key}`,
  /**
   * Phase 11 — resolusi tenant dari `slug` dijalankan di
   * `tenantMiddleware` pada SETIAP request yang membawa header
   * `X-Tenant-ID` (lihat `tenant.middleware.ts`), jadi perlu di-cache
   * seperti `featureFlag` di atas supaya tidak jadi satu query
   * database tambahan per request. TTL pendek (lihat
   * `TenantService.TENANT_CACHE_TTL_SECONDS`) — cukup untuk meredam
   * beban traffic tinggi, cukup singkat agar perubahan status tenant
   * (mis. SUSPENDED) tidak butuh invalidasi manual untuk terlihat.
   */
  tenantBySlug: (slug: string): string => `cache:tenant:slug:${slug}`,
  /**
   * Fase 2 (item 2.11 — rate limit per-tier/plan) — plan tenant
   * berdasarkan `id` (bukan slug): jalur API key
   * (`authenticateWithApiKey`) hanya tahu `ApiKey.tenantId`, tidak
   * punya slug. Hanya menyimpan plan-nya (string kecil atau `null`),
   * bukan seluruh baris Tenant. TTL sama dengan `tenantBySlug`, dan
   * diinvalidasi eksplisit oleh `TenantService.updatePlan`.
   */
  tenantPlanById: (tenantId: string): string => `cache:tenant:plan:${tenantId}`,
};
