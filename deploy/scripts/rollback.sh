#!/usr/bin/env bash
#
# Rollback KODE ke commit terakhir yang sehat (ditulis oleh
# `deploy.sh` ke `.last-known-good-commit` sebelum tiap deploy).
# Bisa dipanggil OTOMATIS oleh `deploy.sh` (saat health check gagal)
# ATAU MANUAL oleh operator kapan saja:
#   ./deploy/scripts/rollback.sh
#
# YANG DI-ROLLBACK: kode aplikasi saja (git checkout + rebuild +
# reload). YANG TIDAK DI-ROLLBACK OTOMATIS: skema/data database.
#
# Ini KEPUTUSAN SADAR, bukan keterbatasan yang terlewat: Prisma
# migration TIDAK selalu punya kebalikan yang aman secara OTOMATIS
# (mis. migration yang menghapus kolom — kembali ke kode lama tidak
# mengembalikan datanya). Mengembalikan migration secara membabi buta
# lewat script bisa MENAMBAH kerusakan data, bukan memperbaikinya.
# Kalau rollback ini dipicu karena migration yang bermasalah (bukan
# bug murni di kode), operator HARUS meninjau manual: restore dari
# backup step [2/6] `deploy.sh` (lihat `restore-db.sh`) adalah jalur
# yang aman untuk itu, dilakukan SADAR oleh manusia, bukan otomatis.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LAST_GOOD_FILE="${PROJECT_ROOT}/.last-known-good-commit"

cd "$PROJECT_ROOT"

if [ ! -f "$LAST_GOOD_FILE" ]; then
  echo "[ERROR] ${LAST_GOOD_FILE} tidak ditemukan — belum pernah ada deploy sukses yang tercatat dari script ini. Rollback dibatalkan." >&2
  exit 1
fi

PREVIOUS_COMMIT="$(cat "$LAST_GOOD_FILE")"
echo "[1/3] Rollback kode ke commit: ${PREVIOUS_COMMIT}"
git checkout "$PREVIOUS_COMMIT"
npm ci
npx prisma generate
npm run build

echo "[2/3] Reload zero-downtime ke versi sebelumnya..."
pm2 reload "${SCRIPT_DIR}/../pm2/ecosystem.config.js" --update-env

echo "[3/3] Rollback kode selesai."
echo ""
echo "PENTING: kalau penyebab rollback ini adalah migration database"
echo "(bukan bug kode murni), skema/data BELUM ikut kembali secara"
echo "otomatis. Tinjau manual & pertimbangkan restore dari backup di"
echo "step [2/6] deploy.sh (format gzip plain-SQL dari"
echo "deploy/scripts/backup-db.sh — BUKAN scripts/restore-db.sh di root,"
echo "yang dibuat untuk format pg_restore custom (.dump) dari"
echo "scripts/backup-db.sh, format BERBEDA dan TIDAK kompatibel):"
echo "  gunzip -c <file-backup>.sql.gz | psql \"\$DATABASE_URL\""
