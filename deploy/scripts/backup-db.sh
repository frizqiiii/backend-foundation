#!/usr/bin/env bash
#
# Backup PostgreSQL — dump terkompresi + rotasi otomatis + opsional
# unggah ke S3 (memakai kredensial AWS yang sama dengan fitur upload
# aplikasi, prefix `db-backups/` terpisah dari file upload user).
#
# Jadwalkan lewat cron, mis. setiap hari jam 2 pagi:
#   0 2 * * * /path/ke/project/deploy/scripts/backup-db.sh >> /var/log/backend-foundation-backup.log 2>&1
#
# Variabel yang dibaca dari environment (isi lewat .env atau export
# manual sebelum memanggil script ini):
#   DATABASE_URL        — wajib, format standar Postgres connection URI
#   BACKUP_DIR          — opsional, default ./backups
#   BACKUP_RETENTION_DAYS — opsional, default 7
#   BACKUP_S3_BUCKET    — opsional; kalau diisi, backup ikut diunggah ke S3
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION — dibutuhkan
#     hanya kalau BACKUP_S3_BUCKET diisi

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
FILENAME="backup_${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[ERROR] DATABASE_URL tidak diset. Backup dibatalkan." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "[INFO] Memulai backup -> ${FILEPATH}"
pg_dump "$DATABASE_URL" | gzip > "$FILEPATH"
echo "[INFO] Backup lokal selesai ($(du -h "$FILEPATH" | cut -f1))"

# --- Rotasi: hapus backup lokal yang lebih tua dari RETENTION_DAYS ---
echo "[INFO] Menghapus backup lokal yang lebih tua dari ${RETENTION_DAYS} hari..."
find "$BACKUP_DIR" -name "backup_*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -print -delete

# --- Opsional: unggah ke S3 ---
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    echo "[INFO] Mengunggah ke s3://${BACKUP_S3_BUCKET}/db-backups/${FILENAME}"
    aws s3 cp "$FILEPATH" "s3://${BACKUP_S3_BUCKET}/db-backups/${FILENAME}"

    # Rotasi juga di sisi S3 — hapus object db-backups/ yang lebih tua
    # dari RETENTION_DAYS, supaya biaya storage tidak menumpuk tanpa batas.
    CUTOFF_DATE="$(date -d "-${RETENTION_DAYS} days" +%Y-%m-%d 2>/dev/null || date -v-"${RETENTION_DAYS}"d +%Y-%m-%d)"
    aws s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "db-backups/" \
      --query "Contents[?LastModified<='${CUTOFF_DATE}'].Key" --output text |
      tr '\t' '\n' | while read -r key; do
        if [ -n "$key" ]; then
          echo "[INFO] Menghapus backup S3 kedaluwarsa: $key"
          aws s3 rm "s3://${BACKUP_S3_BUCKET}/${key}"
        fi
      done
  else
    echo "[WARN] BACKUP_S3_BUCKET diset tapi AWS CLI tidak ditemukan — backup S3 dilewati." >&2
  fi
fi

echo "[INFO] Backup selesai: ${FILEPATH}"
