#!/bin/sh
# Dijalankan OTOMATIS oleh entrypoint image postgres, HANYA saat direktori data masih kosong
# (inisialisasi pertama). Membuat role aplikasi yang BUKAN superuser.
#
# Kenapa: image postgres menjadikan `POSTGRES_USER` sebagai superuser bootstrap, dan superuser
# mem-bypass Row-Level Security — walaupun tabelnya `FORCE ROW LEVEL SECURITY`. Kalau aplikasi
# memakai `POSTGRES_USER` sebagai `DATABASE_URL`, isolasi tenant (RLS) TIDAK berlaku sama sekali
# (diukur di stack Compose: `select count(*) from products` = 3 untuk superuser, 0 untuk role
# biasa pada data yang sama). Role bootstrap juga TIDAK bisa diturunkan setelah dibuat
# ("The bootstrap user must have the SUPERUSER attribute"), jadi role aplikasi harus dibuat terpisah.
#
# Variabel (diteruskan dari compose): APP_DB_USER, APP_DB_PASSWORD. `POSTGRES_USER` dan
# `POSTGRES_DB` berasal dari image. CREATEDB dibutuhkan `prisma migrate dev` (shadow database).
set -eu

: "${APP_DB_USER:?APP_DB_USER wajib diisi}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD wajib diisi}"

if [ "$APP_DB_USER" = "$POSTGRES_USER" ]; then
  echo "APP_DB_USER ('$APP_DB_USER') tidak boleh sama dengan POSTGRES_USER — itu role superuser bootstrap dan mem-bypass RLS." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" -v app_db="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS CREATEDB;
ALTER DATABASE :"app_db" OWNER TO :"app_user";
SQL
