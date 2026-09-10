-- Phase 11 (Enterprise Architecture) — Multi-Tenancy Foundation.
--
-- NON-BREAKING BY DESIGN:
--   1. `tenant_id` ditambahkan sebagai kolom NULLABLE di semua tabel
--      terkait (bukan NOT NULL) — tidak ada baris lama yang gagal
--      divalidasi saat migration ini berjalan.
--   2. Setiap baris yang SUDAH ADA di-backfill ke satu "default
--      tenant" (dibuat dengan id tetap/deterministik di bawah) —
--      bukan dibiarkan NULL — supaya begitu isolasi tenant mulai
--      ditegakkan di kode (Tenant Middleware, Phase 11 lanjutan),
--      data lama tetap konsisten dan bisa diquery seperti tenant lain.
--   3. Foreign key ke `tenants` memakai ON DELETE SET NULL, bukan
--      CASCADE — menghapus sebuah tenant TIDAK BOLEH ikut menghapus
--      user/product/event yang sudah ada.
--
-- Lihat docs/tenant-migration-strategy.md untuk rencana fase
-- berikutnya (mengetatkan kolom ini menjadi NOT NULL setelah seluruh
-- jalur tulis terbukti selalu mengisi tenant_id).

-- 1. Enum status tenant
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- 2. Tabel tenants
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- 3. Default tenant — id TETAP (bukan gen_random_uuid()) supaya
-- deterministik dan bisa dirujuk balik dengan aman dari kode/seed
-- (lihat `prisma/seed.ts`, `DEFAULT_TENANT_ID` di
-- `src/shared/tenant/tenant.constants.ts`) tanpa perlu query lagi.
INSERT INTO "tenants" ("id", "slug", "name", "status", "created_at", "updated_at")
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'default',
    'Default Tenant (pre-Phase 11 legacy data)',
    'ACTIVE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- 4. Tambah kolom tenant_id (nullable) di tabel yang datanya
-- tenant-scoped.
ALTER TABLE "users" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "products" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "events" ADD COLUMN "tenant_id" TEXT;

-- 5. Backfill SELURUH baris lama ke default tenant di atas — lihat
-- alasan "NON-BREAKING BY DESIGN" poin 2 di komentar paling atas.
UPDATE "users" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "products" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "events" SET "tenant_id" = '00000000-0000-0000-0000-000000000001' WHERE "tenant_id" IS NULL;

-- 6. Foreign keys — SET NULL (bukan CASCADE), lihat alasan di atas.
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 7. Index pendukung query tenant-scoped (lihat komentar di
-- schema.prisma untuk alasan urutan kolom pada masing-masing
-- composite index).
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");
CREATE INDEX "products_tenant_id_idx" ON "products"("tenant_id");
CREATE INDEX "products_tenant_id_status_idx" ON "products"("tenant_id", "status");
CREATE INDEX "events_tenant_id_idx" ON "events"("tenant_id");
CREATE INDEX "events_tenant_id_date_idx" ON "events"("tenant_id", "date");
