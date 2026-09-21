#!/usr/bin/env bash
#
# verify-backup.sh — Verifikasi OTOMATIS bahwa backup database
# benar-benar bisa dipakai untuk restore (Phase 20 — Disaster
# Recovery: "Automated backup verification"), bukan cuma berasumsi
# valid karena `backup-db.sh` selesai tanpa error (file yang korup
# tetap bisa "berhasil" ditulis ke disk — lihat catatan di
# `docs/backup-restore-guide.md`).
#
# Mengotomasi PERSIS prosedur manual yang sudah didokumentasikan di
# `docs/backup-restore-guide.md` § "Verifikasi Backup Benar-Benar
# Bisa Dipakai":
#   1. Restore backup ke database TERPISAH (bukan production).
#   2. Bandingkan jumlah baris tabel kunci dengan production SAAT
#      BACKUP DIBUAT (bukan production SEKARANG — datanya sudah
#      pasti bertambah sejak itu, membandingkannya akan SELALU
#      "gagal" secara keliru). Angka "saat backup dibuat" diambil
#      dari sidecar `<backup>.dump.meta` yang ditulis `backup-db.sh`
#      TEPAT setelah dump selesai — lihat komentar di sana.
#   3. Cocok -> backup terbukti valid.
#
# HANYA kompatibel dengan format `.dump` dari `scripts/backup-db.sh`
# (custom format pg_dump + sidecar `.meta`) — SAMA seperti
# `scripts/restore-db.sh`. TIDAK menangani `.sql.gz` dari
# `deploy/scripts/backup-db.sh` (lihat catatan "dua skrip backup
# tidak kompatibel" di `docs/backup-restore-guide.md` — keputusan
# yang SAMA, didokumentasikan apa adanya, bukan gap yang terlewat).
#
# Penggunaan:
#   VERIFY_DATABASE_URL="postgresql://user:pass@host:5432/verify_db" \
#     ./scripts/verify-backup.sh                                  # backup TERBARU di ./backups/
#   VERIFY_DATABASE_URL="postgresql://..." \
#     ./scripts/verify-backup.sh ./backups/backup_20260806.dump   # backup tertentu
#
# Cocok dijadwalkan cron/CI berkala (mis. bulanan, sesuai anjuran di
# `docs/backup-restore-guide.md`) — exit code bukan-nol kalau backup
# TERBUKTI tidak valid, cocok jadi trigger alert.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
# Tabel kunci yang dibandingkan — SAMA PERSIS dengan yang direkam
# `backup-db.sh` ke sidecar `.meta` (lihat script itu). Diulang di
# sini (bukan dibaca dari file bersama) karena keduanya adalah skrip
# bash mandiri tanpa mekanisme "import" — konsistensi dijaga manual,
# lihat komentar yang SAMA di kedua file.
KEY_TABLES="users events products api_keys webhook_endpoints export_jobs"

if ! command -v pg_restore &> /dev/null; then
  echo "FATAL: pg_restore tidak ditemukan. Install postgresql-client (mis. apt install postgresql-client)." >&2
  exit 1
fi
if ! command -v psql &> /dev/null; then
  echo "FATAL: psql tidak ditemukan. Install postgresql-client (mis. apt install postgresql-client)." >&2
  exit 1
fi

# `VERIFY_DATABASE_URL` WAJIB diisi eksplisit — SENGAJA TIDAK ada
# default apa pun (apalagi jatuh balik ke `DATABASE_URL` production
# dari `.env`). Skrip ini melakukan `pg_restore --clean` (DESTRUKTIF,
# menimpa isi database tujuan) — kalau variabel ini lupa diisi dan
# skrip diam-diam memakai database production sebagai fallback,
# hasilnya adalah insiden sungguhan, bukan sekadar verifikasi gagal.
if [ -z "${VERIFY_DATABASE_URL:-}" ]; then
  echo "FATAL: VERIFY_DATABASE_URL belum diisi." >&2
  echo "Wajib menunjuk ke database KHUSUS VERIFIKASI (kosong/disposable)," >&2
  echo "BUKAN database production — isinya akan DITIMPA oleh proses ini." >&2
  exit 1
fi

# Lapisan proteksi KEDUA (selain mewajibkan env var terpisah di atas):
# tolak berjalan kalau `VERIFY_DATABASE_URL` KEBETULAN sama persis
# dengan `DATABASE_URL` production di `.env` — mis. karena salin-tempel
# yang keliru saat setup cron job. Murah untuk dicek, sangat mahal
# akibatnya kalau tidak.
if [ -f "$ENV_FILE" ]; then
  PROD_DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -n1 | cut -d '=' -f2- | tr -d '"'"'"'' || echo "")
  if [ -n "$PROD_DATABASE_URL" ] && [ "$PROD_DATABASE_URL" = "$VERIFY_DATABASE_URL" ]; then
    echo "FATAL: VERIFY_DATABASE_URL SAMA PERSIS dengan DATABASE_URL production di $ENV_FILE." >&2
    echo "Skrip ini akan MENIMPA database tujuan — pastikan menunjuk ke database verifikasi terpisah." >&2
    exit 1
  fi

  # Temuan T19 — pembanding string di atas GAMPANG dilewati: URL yang menunjuk ke database yang SAMA dengan
  # ejaan berbeda (mis. `localhost` vs `127.0.0.1`, atau tambahan `?sslmode=...`) lolos, lalu `pg_restore
  # --clean` MENIMPA production (terbukti di PostgreSQL 16 sungguhan: 5 baris data baru hilang). Identitas
  # database ditanyakan langsung ke servernya: nama database + OID + waktu start postmaster. Kalau production
  # tidak terjangkau dari mesin ini (verifikasi biasanya jalan di host terpisah), pemeriksaan ini dilewati.
  db_identity() {
    psql --dbname="$1" -tAc "SELECT current_database() || '|' || (SELECT oid FROM pg_database WHERE datname = current_database()) || '|' || pg_postmaster_start_time();" 2>/dev/null || echo ""
  }
  if [ -n "$PROD_DATABASE_URL" ]; then
    PROD_IDENTITY=$(db_identity "$PROD_DATABASE_URL")
    VERIFY_IDENTITY=$(db_identity "$VERIFY_DATABASE_URL")
    if [ -n "$PROD_IDENTITY" ] && [ "$PROD_IDENTITY" = "$VERIFY_IDENTITY" ]; then
      echo "FATAL: VERIFY_DATABASE_URL menunjuk ke database YANG SAMA dengan DATABASE_URL production ($ENV_FILE)," >&2
      echo "walau ejaan URL-nya berbeda. Skrip ini akan MENIMPA database tujuan — dihentikan." >&2
      exit 1
    fi
  fi
fi

# Backup file: dioper eksplisit sebagai argumen, atau default ke
# `.dump` TERBARU di $BACKUP_DIR (paling sering dibutuhkan: "verifikasi
# backup semalam", bukan mengetik nama file setiap kali).
BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE=$(find "$BACKUP_DIR" -name "backup_*.dump" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)
  if [ -z "$BACKUP_FILE" ]; then
    echo "FATAL: Tidak ada file backup_*.dump ditemukan di $BACKUP_DIR, dan tidak ada path diberikan." >&2
    exit 1
  fi
  echo "Tidak ada file dioper — memakai backup terbaru: $BACKUP_FILE"
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "FATAL: File backup tidak ditemukan: $BACKUP_FILE" >&2
  exit 1
fi

META_FILE="${BACKUP_FILE}.meta"
if [ ! -f "$META_FILE" ]; then
  echo "FATAL: Sidecar metadata tidak ditemukan: $META_FILE" >&2
  echo "Backup ini dibuat SEBELUM kapabilitas Automated Backup Verification" >&2
  echo "ditambahkan ke backup-db.sh, atau psql tidak tersedia saat backup dibuat" >&2
  echo "(lihat komentar di backup-db.sh) — tidak ada angka pembanding untuk diverifikasi." >&2
  exit 1
fi

echo "=== Verifikasi backup: $BACKUP_FILE ==="
echo "Metadata: $META_FILE"
echo

echo "Merestore ke database verifikasi ($VERIFY_DATABASE_URL) ..."
if ! pg_restore --dbname="$VERIFY_DATABASE_URL" --clean --if-exists --no-owner --no-privileges -v "$BACKUP_FILE" 2>&1 | tail -20; then
  echo "FATAL: pg_restore gagal — backup TERBUKTI TIDAK VALID (file korup atau tidak lengkap)." >&2
  exit 1
fi
echo "Restore selesai tanpa error fatal."
echo

FAILED=0
for TABLE in $KEY_TABLES; do
  EXPECTED=$(grep -E "^rowcount_${TABLE}=" "$META_FILE" | cut -d'=' -f2- || echo "")
  if [ -z "$EXPECTED" ]; then
    echo "  [LEWATI] $TABLE — tidak ada di metadata (kemungkinan tabel belum ada saat backup dibuat)."
    continue
  fi

  # Temuan T19 — `row_security=off`: role yang tunduk RLS mendapat ERROR (terlihat sebagai [GAGAL]), bukan `0`
  # palsu yang kebetulan sama dengan metadata (tabel ber-RLS selalu terlihat kosong tanpa konteks tenant).
  ACTUAL=$(PGOPTIONS='-c row_security=off' psql --dbname="$VERIFY_DATABASE_URL" -tAc "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "ERROR")

  if [ "$ACTUAL" = "$EXPECTED" ]; then
    echo "  [OK]     $TABLE — $ACTUAL baris (sama persis dengan saat backup dibuat)."
  else
    echo "  [GAGAL]  $TABLE — restore menghasilkan $ACTUAL baris, seharusnya $EXPECTED (sesuai metadata backup)."
    FAILED=1
  fi
done

echo
if [ "$FAILED" -eq 0 ]; then
  echo "=== Backup TERVERIFIKASI valid — seluruh tabel kunci cocok dengan metadata saat backup dibuat. ==="
  exit 0
else
  echo "=== Backup GAGAL VERIFIKASI — ada tabel kunci yang jumlah barisnya TIDAK cocok. Lihat detail di atas. ===" >&2
  exit 1
fi
