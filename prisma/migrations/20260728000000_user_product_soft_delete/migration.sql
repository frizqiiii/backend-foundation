-- Phase 3 (Database Professional): soft delete untuk User & Product,
-- pola yang sama seperti `Event.deletedAt` yang sudah ada sejak
-- migration sebelumnya.
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);

ALTER TABLE "products" ADD COLUMN "deleted_at" TIMESTAMP(3);
