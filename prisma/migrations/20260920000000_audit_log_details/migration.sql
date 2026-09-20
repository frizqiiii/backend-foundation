-- Temuan T2: kolom `details` pada audit_logs — konteks perubahan (mis. plan tenant
-- sebelum -> sesudah) sebagai TEKS JSON persis seperti yang di-hash saat baris dibuat.
--
-- Aman terhadap WORM: trigger `audit_logs_prevent_update`/`prevent_delete` hanya memblokir
-- UPDATE/DELETE baris; `ALTER TABLE ... ADD COLUMN` adalah DDL dan tidak menyentuh baris
-- yang sudah ada (semuanya berisi NULL). Aman terhadap hash chain: `details` ikut di-hash
-- HANYA kalau non-NULL, jadi hash baris lama tidak berubah dan chain lama tetap valid.

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "details" TEXT;
