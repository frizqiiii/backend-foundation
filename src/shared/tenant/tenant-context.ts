import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient } from '@prisma/client';

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
 *
 * Fase 4 (RLS) — field `db` DITAMBAHKAN di sini. Sebelum RLS,
 * `tenantId`/`tenantSlug` saja cukup (Repository memfilter manual).
 * Sekarang, KALAU tenant context aktif, `db` berisi Prisma
 * TRANSACTION CLIENT yang sudah membawa `app.tenant_id` (lewat
 * `set_config(..., true)`, lihat `tenant.middleware.ts`) — Repository
 * yang menyentuh tabel ber-RLS WAJIB memakai client INI (lewat
 * `getScopedPrisma`), bukan client singleton biasa, atau RLS akan
 * fail-closed (menolak semua baris) walau tenant context "terlihat"
 * aktif di sisi aplikasi.
 */
export interface TenantContextValue {
  /** UUID internal `Tenant.id`. `null` = request TIDAK punya tenant
   * context aktif (mis. endpoint publik/infrastruktur seperti
   * `/health`, atau — selama masa transisi Phase 11 — endpoint bisnis
   * yang dipanggil tanpa header tenant sama sekali, lihat
   * `tenant.middleware.ts`). */
  tenantId: string | null;
  tenantSlug: string | null;
  /**
   * Prisma transaction client yang sudah di-set `app.tenant_id` untuk
   * tenant ini (dibuka oleh `tenantMiddleware`, hidup selama SATU
   * siklus request). `null` kalau tidak ada tenant aktif — di kondisi
   * ini AMAN memakai Prisma client biasa (lihat `getScopedPrisma`),
   * karena RLS sudah fail-closed secara alami untuk tabel yang
   * dilindungi begitu `app.tenant_id` tidak pernah di-set di koneksi
   * manapun.
   */
  db: Prisma.TransactionClient | null;
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
 * (`tenantId: null`, `db: null`) — BUKAN melempar error — kalau
 * dipanggil di luar `runWithTenantContext` (mis. dari test yang tidak
 * lewat middleware, atau dari worker yang belum diinstrumentasi
 * tenant context-nya). Pemanggil yang MEWAJIBKAN tenant aktif harus
 * mengecek `tenantId` sendiri dan melempar error yang sesuai
 * konteksnya (lihat `requireTenantId` di bawah) — helper ini sendiri
 * tidak berasumsi tenant selalu wajib, karena tidak semua bagian
 * aplikasi tenant-scoped (mis. `/auth/register` sebelum user attach ke
 * tenant mana pun).
 */
export function getTenantContext(): TenantContextValue {
  return storage.getStore() ?? { tenantId: null, tenantSlug: null, db: null };
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

/**
 * Fase 4 (RLS) — Prisma client yang HARUS dipakai Repository untuk
 * operasi apa pun yang menyentuh tabel yang sudah dilindungi RLS
 * (lihat migration `20260913120000_enable_rls_multi_tenancy`:
 * `products`, `events`, `api_keys`, `webhook_endpoints`,
 * `export_jobs`).
 *
 * - Tenant context aktif -> mengembalikan `db` (transaction client
 *   yang sudah membawa `app.tenant_id`, dibuka `tenantMiddleware`).
 * - Tidak ada tenant context -> mengembalikan `fallback` (client
 *   singleton biasa) APA ADANYA. Ini AMAN, BUKAN celah: tanpa
 *   `app.tenant_id` ter-set di koneksi manapun, policy RLS di kelima
 *   tabel itu fail-closed dengan sendirinya (lihat komentar migration)
 *   — jadi memakai client biasa di sini tidak membuka akses apa pun
 *   yang seharusnya tertutup.
 *
 * PENTING untuk Repository yang membungkus BEBERAPA operasi dalam
 * `$transaction([...])` (array form, mis. `ProductRepository.
 * applyUpgrade`): `Prisma.TransactionClient` (`db`) TIDAK punya method
 * `$transaction` — Postgres/Prisma tidak mendukung transaksi
 * bersarang. Kalau `getScopedPrisma(...)` mengembalikan `db` (berarti
 * kita SUDAH berada di dalam satu transaksi milik request ini),
 * operasi-operasi itu HARUS dijalankan berurutan langsung lewat `db`
 * (otomatis atomic terhadap transaksi request yang sama) — BUKAN
 * dibungkus `$transaction([...])` lagi. Lihat contoh penanganannya di
 * `ProductRepository.applyUpgrade`.
 */
export function getScopedPrisma(fallback: PrismaClient): PrismaClient | Prisma.TransactionClient {
  const { db } = getTenantContext();
  return db ?? fallback;
}

/**
 * Menjalankan `fn` dengan `app.bypass_rls = 'on'` aktif untuk KODE
 * DI DALAM `fn` SAJA (transaksi terpisah, tidak "membocorkan" bypass
 * ke request/transaksi lain). Dipakai TERBATAS untuk operasi internal
 * yang SENGAJA lintas-tenant (mis. job admin/migrasi data, backfill
 * baris `tenant_id NULL` lama) — SETIAP pemakaian helper ini adalah
 * titik yang perlu diaudit manual (lihat daftar pemakaian yang
 * diizinkan di docs/tenant-migration-strategy.md); jangan dipanggil
 * dari kode yang melayani request pengguna biasa.
 */
export async function withRlsBypass<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx);
  });
}
