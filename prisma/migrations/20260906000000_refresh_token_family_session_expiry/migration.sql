-- Finding #20 (P1 Security Hardening — Session/Refresh Token) — batas
-- absolut satu family sesi, terpisah dari `expires_at` per-baris yang
-- terus direset tiap rotasi. Lihat komentar lengkap pada field
-- `familySessionExpiresAt` di schema.prisma dan `ABSOLUTE_SESSION_MAX_MS`
-- di auth.service.ts.
--
-- Ditambahkan sebagai NULLABLE dulu supaya bisa di-backfill untuk baris
-- yang sudah ada (pola sama seperti migration `family_id` sebelumnya),
-- BUKAN karena kolom ini dimaksudkan nullable secara permanen — baris
-- baru SELALU mengisi nilai ini (lihat `AuthRepository.createRefreshToken`,
-- parameter wajib, bukan opsional).
ALTER TABLE "refresh_tokens" ADD COLUMN "family_session_expires_at" TIMESTAMP(3);

-- Backfill baris LAMA: pakai `created_at` baris itu sendiri + 30 hari
-- sebagai perkiraan batas absolut. Ini SEDIKIT longgar dibanding baris
-- baru yang benar-benar dihitung dari login pertama family-nya (baris
-- lama tidak punya cara melacak mundur kapan family-nya pertama lahir
-- kalau sudah melalui beberapa kali rotasi sebelum kolom ini ada) —
-- tapi tetap AMAN: begitu backfill ini berlaku, batas 30-hari tetap
-- mulai berlaku sejak titik ini, tidak ada family yang tiba-tiba
-- langsung dianggap kedaluwarsa begitu migration jalan.
UPDATE "refresh_tokens" SET "family_session_expires_at" = "created_at" + INTERVAL '30 days'
WHERE "family_session_expires_at" IS NULL;

ALTER TABLE "refresh_tokens" ALTER COLUMN "family_session_expires_at" SET NOT NULL;
