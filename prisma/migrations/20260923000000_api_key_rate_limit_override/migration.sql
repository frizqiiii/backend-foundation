-- T4: kolom `rate_limit_override_per_minute` pada api_keys — override kuota
-- per-menit KHUSUS satu key, di luar tier plan tenant pemiliknya.
--
-- Nullable, TANPA default eksplisit -> Postgres mengisi NULL untuk seluruh
-- baris yang sudah ada. NULL berarti "pakai tier plan seperti biasa"
-- (lihat rate-limit-tiers.ts), jadi migration ini backward compatible
-- penuh: tidak ada API key yang tiba-tiba berubah kuotanya.

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "rate_limit_override_per_minute" INTEGER;
