-- Phase 20 (Reporting & Analytics Service): tambah 5 nilai enum baru
-- ke `ExportType` supaya statistik per-domain (user/event/product/
-- system) dan tren daily active users bisa diexport CSV/XLSX/PDF
-- lewat pipeline export yang SUDAH ADA (queue + object storage),
-- bukan pipeline baru — lihat ExportService.buildDataset.
-- ALTER TYPE ... ADD VALUE tidak bisa dijalankan di dalam transaksi
-- eksplisit yang sama dengan statement lain, jadi migration ini
-- SENGAJA hanya berisi statement-statement ini saja (pola sama persis
-- dengan migration 20260805000000_session_audit_actions).
ALTER TYPE "ExportType" ADD VALUE 'USER_STATISTICS';
ALTER TYPE "ExportType" ADD VALUE 'EVENT_STATISTICS';
ALTER TYPE "ExportType" ADD VALUE 'PRODUCT_STATISTICS';
ALTER TYPE "ExportType" ADD VALUE 'SYSTEM_STATISTICS';
ALTER TYPE "ExportType" ADD VALUE 'DAILY_ACTIVE_USERS';
