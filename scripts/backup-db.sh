#!/usr/bin/env bash
#
# backup-db.sh — Backup database PostgreSQL memakai pg_dump.
#
# Membaca DATABASE_URL LANGSUNG dari .env (bukan dari environment
# variable yang harus di-export manual dulu) — konsisten dengan cara
# aplikasi sendiri membaca konfigurasi (lihat `shared/config/env.ts`),
# supaya script ini otomatis backup database yang SAMA dengan yang
# sedang dipakai aplikasi tanpa perlu duplikasi konfigurasi koneksi.
#
# Format output: custom format Postgres (`-F c`), BUKAN plain SQL —
# custom format terkompresi otomatis DAN mendukung restore selektif
# (pilih tabel tertentu saja lewat `pg_restore -t`), sementara plain
# SQL dump hanya bisa di-restore utuh dari awal sampai akhir.
#
# Penggunaan:
#   ./scripts/backup-db.sh                  # backup ke ./backups/
#   BACKUP_DIR=/mnt/backups ./scripts/backup-db.sh   # override lokasi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
# Retensi backup lokal — file lebih tua dari ini dihapus otomatis
# setiap kali script dijalankan, supaya folder backup tidak tumbuh
# tanpa batas di disk lokal. Untuk retensi jangka panjang, pindahkan
# hasil backup ke object storage (S3, dst) lewat job terpisah — script
# ini sengaja hanya menangani "backup lokal harian", bukan strategi
# retensi jangka panjang penuh.
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if ! command -v pg_dump &> /dev/null; then
  echo "FATAL: pg_dump tidak ditemukan. Install postgresql-client (mis. apt install postgresql-client)." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: File .env tidak ditemukan di $ENV_FILE" >&2
  echo "Salin dari .env.example dan isi DATABASE_URL terlebih dahulu." >&2
  exit 1
fi

# Ambil HANYA baris DATABASE_URL, buang komentar/baris lain, lalu
# lucuti tanda kutip — .env memakai format `KEY="value"` (lihat
# .env.example), pg_dump butuh URL polos tanpa kutip.
DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d '=' -f2- | tr -d '"'"'"'')

if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: DATABASE_URL tidak ditemukan/kosong di $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.dump"

echo "Memulai backup database ke $BACKUP_FILE ..."

# `-F c` (custom format): terkompresi, mendukung restore paralel &
# selektif lewat pg_restore. `-v` (verbose) ke stderr agar progress
# terlihat tanpa mencampur output dengan hasil dump itu sendiri.
if pg_dump --dbname="$DATABASE_URL" -F c -v -f "$BACKUP_FILE"; then
  BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "Backup berhasil: $BACKUP_FILE ($BACKUP_SIZE)"
else
  echo "FATAL: pg_dump gagal — backup TIDAK berhasil dibuat." >&2
  rm -f "$BACKUP_FILE" # jangan tinggalkan file dump yang setengah jadi/rusak
  exit 1
fi

# Sidecar `.meta` (Phase 20 — Automated Backup Verification) — jumlah
# baris beberapa tabel KUNCI, direkam SAAT INI JUGA (bukan ditebak
# belakangan) sementara `DATABASE_URL` masih menunjuk ke database yang
# PERSIS sama dengan isi backup di atas. `scripts/verify-backup.sh`
# nanti membandingkan angka INI (bukan jumlah baris production
# SEKARANG, yang sudah pasti berbeda karena waktu terus berjalan)
# terhadap hasil restore backup ini — itulah cara satu-satunya untuk
# memverifikasi "restore menghasilkan data yang SAMA PERSIS dengan
# yang di-dump", bukan sekadar "restore tidak error".
#
# Kalau `psql` tidak tersedia atau query gagal (mis. tabel belum ada
# di database yang sangat baru), tetap TIDAK menggagalkan backup itu
# sendiri — dump di atas SUDAH berhasil dan itu yang utama; sidecar
# metadata adalah kapabilitas TAMBAHAN, bukan syarat sah backup.
META_FILE="${BACKUP_FILE}.meta"
if command -v psql &> /dev/null; then
  {
    echo "backup_file=$(basename "$BACKUP_FILE")"
    echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for TABLE in users events products; do
      COUNT=$(psql --dbname="$DATABASE_URL" -tAc "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "")
      if [ -n "$COUNT" ]; then
        echo "rowcount_${TABLE}=${COUNT}"
      fi
    done
  } > "$META_FILE"
  echo "Metadata verifikasi ditulis: $META_FILE"
else
  echo "PERINGATAN: psql tidak ditemukan — melewati metadata verifikasi (backup TETAP valid, hanya tidak bisa diverifikasi otomatis nanti lewat verify-backup.sh)." >&2
fi

# Hapus backup lokal yang lebih tua dari RETENTION_DAYS — dijalankan
# SETELAH backup baru berhasil dibuat, supaya kalau proses ini gagal
# di tengah jalan, backup TERBARU tetap sudah aman tersimpan lebih
# dulu sebelum file lama mana pun disentuh.
DELETED_COUNT=$(find "$BACKUP_DIR" -name "backup_*.dump" -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
if [ "$DELETED_COUNT" -gt 0 ]; then
  echo "Menghapus $DELETED_COUNT backup lokal yang lebih tua dari $RETENTION_DAYS hari."
fi
# Sidecar `.meta` ikut dibersihkan dengan retensi yang SAMA — kalau
# tidak, file metadata yatim (induk `.dump`-nya sudah terhapus di atas)
# akan menumpuk di folder backup selamanya.
find "$BACKUP_DIR" -name "backup_*.dump.meta" -type f -mtime "+$RETENTION_DAYS" -delete

echo "Selesai."
