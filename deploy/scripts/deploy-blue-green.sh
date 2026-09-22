#!/usr/bin/env bash
#
# Fase 2 (Kelompok 2, item 2.8) — otomatisasi PENUH prosedur switch
# yang sebelumnya manual di
# deploy/nginx/backend-foundation.blue-green.conf.example. Lihat
# docs/blue-green-deployment.md untuk desain lengkap & hasil
# verifikasi.
#
# TEMUAN T20 (diperbaiki di versi ini): versi sebelumnya menjalankan
# `git pull`/`npm ci`/`prisma migrate deploy`/`npm run build` SATU
# KALI di SATU direktori yang dipakai BERSAMA oleh blue & green (cuma
# port/proses PM2 yang beda). Dibuktikan nyata (cluster PM2 sungguhan
# + traffic HTTP kontinu): build "green" menimpa dist/ yang SAMA
# dipakai proses "blue" yang masih aktif — worker blue yang
# autorestart (mis. kena max_memory_restart, kejadian rutin, BUKAN
# tindakan deploy) langsung menjalankan kode BARU yang belum pernah
# lolos health check, tanpa nginx atau health-gate script ikut campur
# sama sekali. Perbaikan: blue & green sekarang WAJIB dua direktori
# terpisah (masing-masing clone git penuh sendiri, node_modules &
# dist sendiri) — build hanya pernah menyentuh direktori STANDBY,
# direktori ACTIVE (yang masih melayani traffic nyata) tidak disentuh
# sama sekali sampai traffic benar-benar sudah di-switch.
#
# PRASYARAT (sesuai README — keputusan operasional, bukan otomatis):
#   1. DUA direktori clone git terpisah harus sudah ada (lihat
#      "Setup sekali di awal" di docs/blue-green-deployment.md),
#      diarahkan lewat BLUE_APP_DIR & GREEN_APP_DIR di bawah.
#   2. Kapasitas server 2x lipat selama masa transisi (blue+green
#      berjalan BERSAMAAN sebentar) — sekarang juga 2x lipat disk
#      (dua node_modules terpisah), bukan cuma 2x proses.
#   3. Nginx sudah pakai upstream `backend_blue_green` (lihat
#      backend-foundation.blue-green.conf.example) — BUKAN
#      `proxy_pass http://127.0.0.1:3000` langsung.
#
# Dipanggil TANPA argumen — script ini otomatis mendeteksi warna
# mana yang sedang standby dan deploy ke situ.
set -euo pipefail

# Overridable lewat env var (pola yang sama seperti BACKUP_DATABASE_URL
# di backup-db.sh) — dipakai oleh src/shared/security/blue-green-scripts.spec.ts
# untuk menguji alur skrip tanpa nginx sungguhan. Di produksi biarkan default.
NGINX_CONF="${NGINX_CONF:-/etc/nginx/sites-enabled/backend-foundation.conf}"
HEALTH_RETRIES=20
HEALTH_INTERVAL_SECONDS=1

# Temuan T20 — dua direktori WAJIB, bukan opsional dan bukan fallback
# ke satu direktori bersama (itu justru bug yang sedang diperbaiki).
# Default mengikuti konvensi penamaan yang sudah ada di
# deploy/README.md (`/var/www/backend-foundation` untuk deploy
# non-blue-green biasa).
BLUE_APP_DIR="${BLUE_APP_DIR:-/var/www/backend-foundation-blue}"
GREEN_APP_DIR="${GREEN_APP_DIR:-/var/www/backend-foundation-green}"

# Preflight fail-closed (pola yang sama seperti T19): direktori harus
# ADA, harus jadi clone git SENDIRI (`.git`-nya sendiri, bukan
# symlink ke satu tempat), dan TIDAK BOLEH menunjuk ke path yang
# sama (realpath) — kalau sama, ini persis kondisi bug T20 yang
# diperbaiki di sini, jadi ditolak keras alih-alih diam-diam
# mengulangi bug lama.
for d_name in BLUE_APP_DIR GREEN_APP_DIR; do
  d_val="${!d_name}"
  if [ ! -d "$d_val" ] || [ ! -d "$d_val/.git" ]; then
    echo "FATAL: $d_name=\"$d_val\" tidak ada atau bukan clone git sendiri (tidak ada .git di dalamnya)." >&2
    echo "Setiap warna WAJIB direktori clone terpisah sendiri — lihat 'Setup sekali di awal' di docs/blue-green-deployment.md (temuan T20)." >&2
    exit 1
  fi
done
REAL_BLUE_DIR="$(cd "$BLUE_APP_DIR" && pwd -P)"
REAL_GREEN_DIR="$(cd "$GREEN_APP_DIR" && pwd -P)"
if [ "$REAL_BLUE_DIR" = "$REAL_GREEN_DIR" ]; then
  echo "FATAL: BLUE_APP_DIR dan GREEN_APP_DIR menunjuk ke direktori FISIK yang SAMA ($REAL_BLUE_DIR)." >&2
  echo "Ini persis bug T20 (build satu warna menimpa file warna yang masih aktif) — dua direktori HARUS benar-benar terpisah." >&2
  exit 1
fi

# Warna aktif ditentukan dari baris `server ... backup;` di config
# nginx yang SUDAH TERPASANG — yang PUNYA `backup` adalah standby,
# yang TIDAK punya adalah yang sedang melayani traffic nyata.
if grep -q "127.0.0.1:3001 backup;" "$NGINX_CONF" 2>/dev/null; then
  ACTIVE_COLOR="blue"; ACTIVE_PORT=3000
  STANDBY_COLOR="green"; STANDBY_PORT=3001
  STANDBY_DIR="$GREEN_APP_DIR"; STANDBY_ECOSYSTEM="$STANDBY_DIR/deploy/pm2/ecosystem.green.config.js"
  STANDBY_APP="backend-foundation-api-green"
elif grep -q "127.0.0.1:3000 backup;" "$NGINX_CONF" 2>/dev/null; then
  ACTIVE_COLOR="green"; ACTIVE_PORT=3001
  STANDBY_COLOR="blue"; STANDBY_PORT=3000
  STANDBY_DIR="$BLUE_APP_DIR"; STANDBY_ECOSYSTEM="$STANDBY_DIR/deploy/pm2/ecosystem.config.js"
  STANDBY_APP="backend-foundation-api"
else
  echo "GAGAL: tidak menemukan pola upstream blue-green di $NGINX_CONF."
  echo "Pastikan nginx sudah dikonfigurasi sesuai backend-foundation.blue-green.conf.example."
  exit 1
fi

echo "[1/6] Warna aktif saat ini: $ACTIVE_COLOR (port $ACTIVE_PORT). Deploy ke: $STANDBY_COLOR (port $STANDBY_PORT, direktori $STANDBY_DIR)."

# Temuan T20 — build HANYA di direktori STANDBY. Direktori ACTIVE
# (dan proses PM2 yang sedang melayani traffic dari situ) TIDAK
# disentuh sama sekali oleh baris-baris di bawah ini.
echo "[2/6] Menarik kode terbaru & build DI DIREKTORI STANDBY SAJA ($STANDBY_DIR)..."
cd "$STANDBY_DIR"
git pull --ff-only
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build

echo "[3/6] Menyalakan/restart instance $STANDBY_COLOR lewat PM2 (dari $STANDBY_DIR)..."
pm2 start "$STANDBY_ECOSYSTEM" --update-env 2>/dev/null || pm2 restart "$STANDBY_APP" --update-env

echo "[4/6] Health check LANGSUNG ke instance $STANDBY_COLOR (BUKAN lewat nginx, port $STANDBY_PORT)..."
for i in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -sf "http://127.0.0.1:${STANDBY_PORT}/ready" > /dev/null 2>&1; then
    echo "    Instance $STANDBY_COLOR siap setelah percobaan ke-$i."
    break
  fi
  if [ "$i" = "$HEALTH_RETRIES" ]; then
    echo "    GAGAL: instance $STANDBY_COLOR tidak /ready setelah $HEALTH_RETRIES percobaan."
    echo "    DEPLOY DIBATALKAN — nginx TIDAK diubah, traffic TETAP di $ACTIVE_COLOR."
    echo "    CATATAN (batas yang diketahui, T20): kalau langkah [2/6] di atas menjalankan migration"
    echo "    database yang TIDAK backward-compatible dengan kode $ACTIVE_COLOR yang masih aktif,"
    echo "    'traffic tetap aman di $ACTIVE_COLOR' TIDAK sepenuhnya benar — migration tidak ikut"
    echo "    dibatalkan oleh baris ini. Tinjau manual sebelum retry kalau kegagalan ini terkait skema."
    exit 1
  fi
  sleep "$HEALTH_INTERVAL_SECONDS"
done

echo "[5/6] Switch traffic nginx ke $STANDBY_COLOR (edit upstream, reload zero-downtime)..."
sudo sed -i \
  -e "s/server 127.0.0.1:${ACTIVE_PORT};/server 127.0.0.1:${ACTIVE_PORT} backup;/" \
  -e "s/server 127.0.0.1:${STANDBY_PORT} backup;/server 127.0.0.1:${STANDBY_PORT};/" \
  "$NGINX_CONF"
sudo nginx -t
sudo systemctl reload nginx

echo "[6/6] Verifikasi traffic LEWAT nginx sekarang benar-benar dilayani $STANDBY_COLOR..."
sleep 1
curl -sf http://127.0.0.1/health > /dev/null && echo "    /health lewat nginx: OK"

echo ""
echo "Deploy selesai. $STANDBY_COLOR SEKARANG AKTIF, $ACTIVE_COLOR jadi standby (TETAP JALAN untuk rollback instan, direktorinya TIDAK disentuh deploy ini)."
echo "Rollback instan (kalau perlu): jalankan ulang script ini SEKALI LAGI untuk switch balik."
echo "Setelah yakin $STANDBY_COLOR stabil di traffic nyata: pm2 stop $([ "$ACTIVE_COLOR" = "blue" ] && echo backend-foundation-api || echo backend-foundation-api-green)"
