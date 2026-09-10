/**
 * Id tenant default — HARUS identik dengan id yang di-insert oleh
 * migration `20260801000000_multi_tenancy_foundation` (lihat
 * `migration.sql`). Dipakai oleh `prisma/seed.ts` (upsert idempoten,
 * bukan insert baru) dan tersedia di sini supaya kode lain yang perlu
 * merujuk "tenant legacy" tidak perlu query database dulu.
 *
 * Nilai ini SENGAJA konstan/hard-coded (bukan UUID acak) — kebalikan
 * dari id tenant lain yang dibuat via `Tenant.id @default(uuid())` —
 * karena baris ini dibuat oleh migration SQL, bukan lewat Prisma
 * Client, dan perlu bisa dirujuk balik secara deterministik dari kode
 * tanpa query tambahan.
 */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_TENANT_SLUG = 'default';

/**
 * Nama header HTTP yang dipakai client untuk menyatakan tenant mana
 * yang sedang mereka akses. `X-Tenant-ID` SENGAJA menerima `slug`
 * (bukan UUID internal `Tenant.id`) sebagai nilainya — konsisten
 * dengan alasan `Tenant.slug` di schema.prisma: slug adalah identitas
 * tenant yang dimaksudkan untuk terlihat/diketik, UUID internal
 * tidak.
 */
export const TENANT_HEADER_NAME = 'x-tenant-id';
