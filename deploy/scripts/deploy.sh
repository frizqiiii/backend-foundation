#!/usr/bin/env bash
#
# Deploy script — dijalankan DI VPS (bukan di GitHub Actions runner;
# lihat `.github/workflows/deploy.yml` yang memanggil ini lewat SSH).
# Alur: backup -> pull -> install -> migrate -> build -> reload
# zero-downtime -> health check -> rollback OTOMATIS kalau health
# check gagal.
#
# Dipanggil dari root project:
#   ./deploy/scripts/deploy.sh
#
# Variabel environment yang dibaca:
#   DATABASE_URL — wajib (dipakai backup-db.sh & prisma migrate deploy)
#   HEALTH_CHECK_URL — opsional, default http://127.0.0.1:3000/ready

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# Phase 21 audit — SEBELUMNYA default ke `/health`. Sejak Phase 18
# memisah `/health` (liveness murni, TIDAK menyentuh database/Redis
# sama sekali by design) dari `/ready` (readiness, MENGECEK koneksi
# database/Redis), memakai `/health` di sini berarti gate rollback
# otomatis TIDAK AKAN terpicu kalau deploy merusak DATABASE_URL/
# koneksi Redis tapi proses Node-nya sendiri tetap hidup — false
# positive "deploy sukses" untuk skenario kegagalan yang justru paling
# umum (salah env var, migration yang membuat query gagal). `/ready`
# adalah endpoint yang BENAR untuk gate ini.
HEALTH_CHECK_URL="${HEALTH_CHECK_URL:-http://127.0.0.1:3000/ready}"
HEALTH_CHECK_RETRIES=10
HEALTH_CHECK_DELAY_SECONDS=3

cd "$PROJECT_ROOT"

echo "[1/6] Mencatat commit SEBELUM deploy (untuk rollback kalau perlu)..."
# Ditulis ke file, BUKAN cuma variabel shell — proses deploy ini bisa
# gagal di tengah jalan dan shell session berakhir; `rollback.sh`
# (dipanggil terpisah, bisa jauh setelah proses ini exit) tetap perlu
# tahu persis commit mana yang terakhir SEHAT.
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
echo "$PREVIOUS_COMMIT" > "${PROJECT_ROOT}/.last-known-good-commit"
echo "    Commit saat ini: ${PREVIOUS_COMMIT}"

echo "[2/6] Backup database SEBELUM migration..."
# WAJIB terjadi SEBELUM `git pull`/`prisma migrate deploy` di bawah —
# kalau migration baru ternyata merusak data, backup ini adalah satu-
# satunya jalan kembali untuk DATA (rollback kode di step terakhir
# hanya mengembalikan KODE, bukan skema/data database yang sudah
# terlanjur ter-migrate).
"${SCRIPT_DIR}/backup-db.sh"

echo "[3/6] Menarik kode terbaru & install dependency..."
git pull --ff-only
npm ci
npx prisma generate

# Fase 2 (Secrets Management, item 2.4) — OPSIONAL, hanya jalan kalau
# VAULT_ADDR diisi (backward compatible untuk deployment yang belum
# pakai Vault, masih baca `.env` manual seperti biasa). Lihat
# docs/secrets-management.md untuk desain lengkapnya. SENGAJA
# dijalankan SEBELUM `pm2 reload` di langkah [5/6] — kalau sync gagal
# (exit code != 0), `set -e` di awal script ini (lihat baris atas)
# akan menghentikan deploy SEBELUM instance baru sempat reload dengan
# `.env` yang mungkin sudah basi/tidak lengkap.
if [ -n "${VAULT_ADDR:-}" ]; then
  echo "[3b/6] Sinkronisasi secret dari Vault..."
  node scripts/sync-secrets-from-vault.js
fi

echo "[4/6] Menjalankan migration & build..."
npx prisma migrate deploy
npm run build

echo "[5/6] Reload zero-downtime (PM2 cluster mode)..."
# `pm2 reload` (BUKAN `restart`) — PM2 mematikan instance LAMA satu
# per satu secara bergiliran sambil instance BARU sudah menyala,
# bukan mematikan semua lalu menyalakan semua (yang akan menyebabkan
# downtime beberapa detik di cluster mode). Ini yang membuat "Zero
# Downtime Deployment" (Phase 14) benar-benar terpenuhi, bukan hanya
# istilah di dokumentasi.
pm2 reload "${SCRIPT_DIR}/../pm2/ecosystem.config.js" --update-env

echo "[6/6] Health check pasca-deploy..."
for attempt in $(seq 1 "$HEALTH_CHECK_RETRIES"); do
  if curl --fail --silent --output /dev/null "$HEALTH_CHECK_URL"; then
    echo "[OK] Health check lolos (percobaan ${attempt}/${HEALTH_CHECK_RETRIES}). Deploy selesai."
    exit 0
  fi
  echo "    Health check belum lolos (percobaan ${attempt}/${HEALTH_CHECK_RETRIES}), tunggu ${HEALTH_CHECK_DELAY_SECONDS}s..."
  sleep "$HEALTH_CHECK_DELAY_SECONDS"
done

# Seluruh percobaan health check habis — deploy dianggap GAGAL.
# Rollback OTOMATIS kode ke commit sebelumnya, bukan dibiarkan
# aplikasi tetap berjalan dalam kondisi rusak menunggu intervensi
# manual. Rollback DATA (kalau migration yang jadi biang masalah)
# tetap harus manual lewat backup di step [2/6] — lihat komentar di
# `rollback.sh` untuk alasannya.
echo "[FAIL] Health check gagal setelah ${HEALTH_CHECK_RETRIES} percobaan. Menjalankan rollback otomatis..." >&2
"${SCRIPT_DIR}/rollback.sh"
exit 1
