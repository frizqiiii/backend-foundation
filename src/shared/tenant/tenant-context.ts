import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tenant Context — state tenant yang aktif untuk request yang sedang
 * berjalan, disimpan lewat `AsyncLocalStorage` (bukan `req.tenant`
 * biasa) SUPAYA layer Repository/Service yang tidak punya akses
 * langsung ke `req` (mis. dipanggil dari BullMQ worker/scheduler,
 * lihat `shared/queue`, `shared/scheduler`) tetap bisa membaca tenant
 * mana yang sedang aktif tanpa perlu mengoper parameter `tenantId` di
 * setiap pemanggilan fungsi secara manual.
 *
 * SENGAJA terpisah dari `shared/utils/request-context.ts` (yang murni
 * helper baca `req`, tidak stateful lintas-async) — dua kebutuhan
 * yang berbeda: itu untuk membaca data yang SUDAH ada di `req`, ini
 * untuk PROPAGASI state ke seluruh call-stack async turunan sebuah
 * request, termasuk callback/promise yang dijadwalkan di dalamnya.
 */
export interface TenantContextValue {
  /** UUID internal `Tenant.id`. `null` = request TIDAK punya tenant
   * context aktif (mis. endpoint publik/infrastruktur seperti
   * `/health`, atau — selama masa transisi Phase 11 — endpoint bisnis
   * yang dipanggil tanpa header tenant sama sekali, lihat
   * `tenant.middleware.ts`). */
  tenantId: string | null;
  tenantSlug: string | null;
}

const storage = new AsyncLocalStorage<TenantContextValue>();

/**
 * Menjalankan `fn` di dalam tenant context tertentu — SATU-SATUNYA
 * cara context ini terisi. Dipanggil oleh `tenantMiddleware` di awal
 * siklus hidup request; kode lain TIDAK PERNAH memanggil ini secara
 * manual di tengah request yang sudah berjalan.
 */
export function runWithTenantContext<T>(context: TenantContextValue, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Membaca tenant context aktif. Mengembalikan context kosong
 * (`tenantId: null`) — BUKAN melempar error — kalau dipanggil di luar
 * `runWithTenantContext` (mis. dari test yang tidak lewat middleware,
 * atau dari worker yang belum diinstrumentasi tenant context-nya).
 * Pemanggil yang MEWAJIBKAN tenant aktif harus mengecek `tenantId`
 * sendiri dan melempar error yang sesuai konteksnya (lihat
 * `requireTenantId` di bawah) — helper ini sendiri tidak berasumsi
 * tenant selalu wajib, karena tidak semua bagian aplikasi
 * tenant-scoped (mis. `/auth/register` sebelum user attach ke
 * tenant mana pun).
 */
export function getTenantContext(): TenantContextValue {
  return storage.getStore() ?? { tenantId: null, tenantSlug: null };
}

/**
 * Sama seperti `getTenantContext().tenantId`, tapi melempar error
 * eksplisit kalau tidak ada tenant aktif — dipakai oleh Repository
 * yang query-nya WAJIB tenant-scoped (mis. yang menyimpan data baru
 * atas nama tenant tertentu) alih-alih diam-diam menyimpan
 * `tenantId: null`.
 */
export function requireTenantId(): string {
  const { tenantId } = getTenantContext();
  if (!tenantId) {
    throw new Error(
      'Tenant context tidak aktif — operasi ini wajib dijalankan di dalam runWithTenantContext (mis. request yang melewati tenantMiddleware dengan header X-Tenant-ID valid).'
    );
  }
  return tenantId;
}
