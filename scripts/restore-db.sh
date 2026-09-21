#!/usr/bin/env bash
#
# restore-db.sh — Restore database PostgreSQL dari file hasil
# backup-db.sh (custom format pg_dump).
#
# Penggunaan:
#   ./scripts/restore-db.sh ./backups/backup_20260315_020000.dump
#   ./scripts/restore-db.sh ./backups/backup_20260315_020000.dump --yes   # lewati konfirmasi (untuk otomasi/CI)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"

BACKUP_FILE="${1:-}"
SKIP_CONFIRMATION="${2:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Penggunaan: $0 <path-ke-file-backup.dump> [--yes]" >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "FATAL: File backup tidak ditemukan: $BACKUP_FILE" >&2
  exit 1
fi

if ! command -v pg_restore &> /dev/null; then
  echo "FATAL: pg_restore tidak ditemukan. Install postgresql-client (mis. apt install postgresql-client)." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: File .env tidak ditemukan di $ENV_FILE" >&2
  exit 1
fi

DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d '=' -f2- | tr -d '"'"'"'')

if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: DATABASE_URL tidak ditemukan/kosong di $ENV_FILE" >&2
  exit 1
fi

# Konfirmasi eksplisit SEBELUM restore — operasi ini bersifat
# DESTRUKTIF (`--clean` di bawah menghapus objek yang sudah ada di
# database tujuan sebelum menimpanya dengan isi backup). Restore yang
# tidak sengaja dijalankan ke database production yang salah adalah
# skenario insiden yang jauh lebih umum daripada kelihatannya — prompt
# ini murah untuk dibuat, sangat mahal akibatnya kalau tidak ada.
# `--yes` melewati prompt ini KHUSUS untuk pipeline otomatis
# (mis. me-restore ke environment staging sebagai bagian CI) yang
# memang tidak seharusnya berhenti menunggu input interaktif.
if [ "$SKIP_CONFIRMATION" != "--yes" ]; then
  # Temuan T19 — password TIDAK dicetak ke layar/scrollback/log terminal: `user:password@host` -> `user:***@host`.
  MASKED_DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#')
  echo "PERINGATAN: Ini akan MENIMPA seluruh data di database tujuan:"
  echo "  $MASKED_DATABASE_URL"
  echo "dengan isi dari:"
  echo "  $BACKUP_FILE"
  read -r -p "Ketik 'yes' untuk melanjutkan: " CONFIRMATION
  if [ "$CONFIRMATION" != "yes" ]; then
    echo "Dibatalkan."
    exit 1
  fi
fi

echo "Memulai restore dari $BACKUP_FILE ..."

# `--clean --if-exists`: hapus objek yang sudah ada (tabel, index,
# dst) sebelum membuat ulang dari isi backup — mencegah restore
# gagal karena "relation already exists" kalau database tujuan
# bukan database yang benar-benar kosong.
# `--no-owner --no-privileges`: abaikan kepemilikan/hak akses PERSIS
# seperti di database sumber — restore ke instance Postgres LAIN
# (mis. staging dengan role/user berbeda dari production) tetap
# berhasil tanpa gagal karena role yang tidak ada di sana.
if pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --no-privileges -v "$BACKUP_FILE"; then
  echo "Restore berhasil."
else
  echo "FATAL: pg_restore melaporkan kegagalan — periksa output di atas dengan saksama." >&2
  echo "Catatan: sebagian pesan 'error' dari pg_restore terkait --clean pada objek yang" >&2
  echo "memang belum ada di database tujuan bersifat NORMAL (bukan indikasi restore gagal)." >&2
  exit 1
fi
