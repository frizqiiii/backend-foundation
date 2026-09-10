-- Phase 9 upgrade (Session/Auth Hardening): Token Family untuk
-- `refresh_tokens`. Ditambahkan NULLABLE dulu supaya baris LAMA yang
-- sudah ada tidak membuat ALTER TABLE gagal, lalu di-backfill dengan
-- `id` mereka sendiri (setiap baris lama memang bukan hasil rotasi
-- apa pun, jadi secara alami adalah family beranggota satu baris),
-- baru kemudian dikunci jadi NOT NULL.
ALTER TABLE "refresh_tokens" ADD COLUMN "family_id" TEXT;

UPDATE "refresh_tokens" SET "family_id" = "id" WHERE "family_id" IS NULL;

ALTER TABLE "refresh_tokens" ALTER COLUMN "family_id" SET NOT NULL;

CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");
