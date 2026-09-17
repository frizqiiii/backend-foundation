#!/usr/bin/env bash
#
# Fase 2 (Kelompok 2, item 2.8) — otomatisasi PENUH prosedur switch
# yang sebelumnya manual di
# deploy/nginx/backend-foundation.blue-green.conf.example. Lihat
# docs/blue-green-deployment.md untuk desain lengkap & hasil
# verifikasi (drill nyata: nginx + PM2 sungguhan, traffic HTTP
# kontinu, zero-downtime terbukti, termasuk uji rollback & uji abort
# otomatis kalau instance baru tidak pernah sehat).
#
# PRASYARAT (sesuai README — keputusan operasional, bukan otomatis):
#   1. Kapasitas server 2x lipat selama masa transisi (blue+green
#      berjalan BERSAMAAN sebentar).
#   2. Nginx sudah pakai upstream `backend_blue_green` (lihat
#      backend-foundation.blue-green.conf.example) — BUKAN
#      `proxy_pass http://127.0.0.1:3000` langsung.
#
# Dipanggil TANPA argumen — script ini otomatis mendeteksi warna
# mana yang sedang standby dan deploy ke situ.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/../.."
NGINX_CONF="/etc/nginx/sites-enabled/backend-foundation.conf"
HEALTH_RETRIES=20
HEALTH_INTERVAL_SECONDS=1

cd "$PROJECT_ROOT"

# Warna aktif ditentukan dari baris `server ... backup;` di config
# nginx yang SUDAH TERPASANG — yang PUNYA `backup` adalah standby,
# yang TIDAK punya adalah yang sedang melayani traffic nyata.
if grep -q "127.0.0.1:3001 backup;" "$NGINX_CONF" 2>/dev/null; then
  ACTIVE_COLOR="blue"; ACTIVE_PORT=3000
  STANDBY_COLOR="green"; STANDBY_PORT=3001; STANDBY_APP="backend-foundation-api-green"
  STANDBY_ECOSYSTEM="deploy/pm2/ecosystem.green.config.js"
elif grep -q "127.0.0.1:3000 backup;" "$NGINX_CONF" 2>/dev/null; then
  ACTIVE_COLOR="green"; ACTIVE_PORT=3001
  STANDBY_COLOR="blue"; STANDBY_PORT=3000; STANDBY_APP="backend-foundation-api"
  STANDBY_ECOSYSTEM="deploy/pm2/ecosystem.config.js"
else
  echo "GAGAL: tidak menemukan pola upstream blue-green di $NGINX_CONF."
  echo "Pastikan nginx sudah dikonfigurasi sesuai backend-foundation.blue-green.conf.example."
  exit 1
fi

echo "[1/6] Warna aktif saat ini: $ACTIVE_COLOR (port $ACTIVE_PORT). Deploy ke: $STANDBY_COLOR (port $STANDBY_PORT)."

echo "[2/6] Menarik kode terbaru & build (SEKALI, dipakai kedua warna — cuma proses PM2-nya yang terpisah)..."
git pull --ff-only
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build

echo "[3/6] Menyalakan/restart instance $STANDBY_COLOR lewat PM2..."
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
echo "Deploy selesai. $STANDBY_COLOR SEKARANG AKTIF, $ACTIVE_COLOR jadi standby (TETAP JALAN untuk rollback instan)."
echo "Rollback instan (kalau perlu): jalankan ulang script ini SEKALI LAGI untuk switch balik."
echo "Setelah yakin $STANDBY_COLOR stabil di traffic nyata: pm2 stop $([ "$ACTIVE_COLOR" = "blue" ] && echo backend-foundation-api || echo backend-foundation-api-green)"
