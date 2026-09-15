-- Fase 2 (Kelompok 2 — Enterprise Features) — Audit log immutability.
-- Dua lapis perlindungan independen (lihat komentar lengkap desain
-- di prisma/schema.prisma & src/modules/audit/audit.repository.ts):
--   1) Trigger WORM di database — BLOKIR TOTAL UPDATE/DELETE pada
--      `audit_logs`, siapa pun/apa pun yang terhubung lewat role
--      aplikasi (termasuk kalau app-nya sendiri suatu saat
--      di-compromise) TIDAK BISA mengubah/menghapus baris audit log
--      yang sudah ada — cuma INSERT yang diizinkan.
--   2) Hash chain (kolom `hash`/`previous_hash` + tabel
--      `audit_chain_state`) — bukti kriptografis kalau SATU baris
--      pun diubah/disisipkan/dihapus, baris tersebut ATAU seluruh
--      rantai setelahnya akan gagal verifikasi (`verifyChainIntegrity`)
--      — lapis pertahanan KEDUA yang tetap efektif walau lapis
--      pertama (trigger) entah bagaimana terlewati (mis. akses
--      langsung sebagai superuser Postgres, migrasi data manual, atau
--      restore dari backup yang punya gap).
--
-- SENGAJA TIDAK backfill hash untuk baris yang SUDAH ADA sebelum
-- migration ini (kolom nullable) — lihat catatan lengkap di
-- docs/audit-log-immutability.md kenapa itu keputusan sadar, bukan
-- kelalaian.

ALTER TABLE "audit_logs" ADD COLUMN "hash" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "previous_hash" TEXT;

CREATE TABLE "audit_chain_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "last_hash" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_chain_state_pkey" PRIMARY KEY ("id")
);

-- WORM enforcement. `RAISE EXCEPTION` (bukan `RETURN NULL`) SENGAJA
-- dipilih — kegagalan harus BERISIK (transaksi pemanggil rollback
-- dengan error jelas), bukan diam-diam gagal tanpa pemberitahuan yang
-- justru bisa disalahartikan sebagai "berhasil".
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs bersifat immutable (WORM) - UPDATE/DELETE tidak diizinkan (percobaan pada baris id=%)', OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_prevent_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TRIGGER audit_logs_prevent_delete
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
