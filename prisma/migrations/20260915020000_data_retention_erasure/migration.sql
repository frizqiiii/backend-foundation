-- Fase 2 (Kelompok 2 — Enterprise Features) — Data retention & GDPR
-- erasure. `erased_at` menandai akun yang SUDAH di-scrub PII-nya
-- (lihat komentar lengkap di prisma/schema.prisma model User dan
-- docs/data-retention-policy.md) — terpisah dari `deleted_at` yang
-- sudah ada (soft-delete, sekadar menonaktifkan akun).

ALTER TABLE "users" ADD COLUMN "erased_at" TIMESTAMP(3);
