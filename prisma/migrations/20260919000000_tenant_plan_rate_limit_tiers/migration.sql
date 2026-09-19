-- Fase 2 (item 2.11 — rate limit per-tier/plan): paket layanan tenant.
--
-- Default kolom 'PRO' SENGAJA (bukan 'FREE'): tier PRO memakai angka
-- yang PERSIS sama dengan limit flat sebelum migration ini (1000
-- request/15 menit per tenant; API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE per
-- API key), jadi SEMUA baris tenants yang sudah ada tetap berperilaku
-- identik setelah migration ini — additive & backward compatible, tidak
-- ada tenant yang tiba-tiba lebih ketat. Menaikkan/menurunkan tier
-- tenant tertentu dilakukan lewat PATCH /api/v1/tenants/:id/plan.

-- CreateEnum
CREATE TYPE "TenantPlan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "plan" "TenantPlan" NOT NULL DEFAULT 'PRO';
