-- Phase 19 (Enterprise Platform) — Export Service.

-- CreateEnum
CREATE TYPE "ExportType" AS ENUM ('USERS', 'AUDIT_LOG', 'DASHBOARD_STATS');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'XLSX', 'PDF');

-- CreateEnum
CREATE TYPE "ExportJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "type" "ExportType" NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "status" "ExportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "file_url" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "export_jobs_user_id_idx" ON "export_jobs"("user_id");

-- SENGAJA TIDAK ada foreign key ke "users" — pola sama dengan
-- "audit_logs" (lihat migration awal): userId di sini murni untuk
-- pelaporan/filtering, riwayat export TETAP harus tersimpan meski
-- user penciptanya sudah dihapus (bukan ikut ter-cascade-delete).
