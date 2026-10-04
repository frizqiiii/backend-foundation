# Role PostgreSQL di Docker Compose: admin vs aplikasi

## Masalah

Image `postgres` menjadikan `POSTGRES_USER` sebagai **superuser bootstrap**. Superuser mem-bypass
Row-Level Security (RLS), walaupun tabelnya `FORCE ROW LEVEL SECURITY`. Sebelumnya kedua file Compose
memakai `POSTGRES_USER=app_user` dan aplikasi memakai user yang sama di `DATABASE_URL`, sehingga **RLS tidak
berlaku sama sekali** di stack Compose.

Bukti (stack Compose dev, data yang sama):

| Role | `select count(*) from products` (tanpa tenant context) |
|---|---|
| `app_user` sebagai superuser bootstrap (sebelum) | 3 (RLS dilewati) |
| `app_user` biasa (`NOSUPERUSER NOBYPASSRLS`) | 0 (RLS ditegakkan) |

Role bootstrap juga **tidak bisa diturunkan** setelah dibuat
(`ERROR: permission denied to alter role — The bootstrap user must have the SUPERUSER attribute`).
Role aplikasi karenanya harus dibuat TERPISAH.

## Desain sekarang

| Role | Atribut | Dipakai oleh |
|---|---|---|
| `postgres` (`POSTGRES_USER`) | superuser | hanya inisialisasi dan administrasi |
| `DB_USER` (default `app_user`) | `NOSUPERUSER NOBYPASSRLS CREATEDB`, owner database | aplikasi, worker, migrasi |

`deploy/postgres/01-app-role.sh` dipasang ke `/docker-entrypoint-initdb.d/` dan membuat role aplikasi
saat inisialisasi pertama. Password dilewatkan sebagai variabel psql (`:'app_password'`), bukan
digabung ke string SQL, jadi karakter khusus aman. Skrip menolak `APP_DB_USER` yang sama dengan
`POSTGRES_USER`. `CREATEDB` dibutuhkan `prisma migrate dev` (shadow database).

Variabel baru di `docker-compose.prod.yml`: **`DB_ADMIN_PASSWORD`** (wajib, beda dari `DB_PASSWORD`).
Dev memakai nilai tetap (`postgres_admin_dev`).

## Instalasi baru (volume kosong)

Tidak ada langkah tambahan: role dibuat otomatis. Verifikasi:

```bash
docker compose exec postgres_db psql -U postgres -d app_db -c \
  "select rolname, rolsuper, rolbypassrls from pg_roles where rolname='app_user';"   # f | f
docker compose exec backend_app npx prisma migrate deploy
```

## Volume yang SUDAH ada (dibuat dengan versi lama)

Skrip init hanya jalan pada direktori data kosong, dan role bootstrap lama tidak bisa diturunkan.
Jalurnya: dump, buat volume baru, restore tanpa owner lama. Urutan ini diuji pada PostgreSQL 16
(dump dari database ber-superuser, restore ke role biasa: semua tabel, data, dan 5 tabel
RLS+FORCE ikut, owner berpindah ke role aplikasi). Belum diuji end-to-end lewat Compose.

```bash
# 1. Backup (di stack LAMA, masih berjalan)
docker compose -f docker-compose.prod.yml exec -T postgres_db \
  pg_dump -U "${DB_USER:-app_user}" -d "${DB_NAME:-app_db}" -Fc --no-owner --no-privileges > backup.dump

# 2. Hentikan stack dan buang volume lama
docker compose -f docker-compose.prod.yml down
docker volume rm "$(docker volume ls -q | grep postgres_data)"   # periksa namanya dulu!

# 3. Isi DB_ADMIN_PASSWORD di .env, nyalakan HANYA database (init membuat role aplikasi)
docker compose -f docker-compose.prod.yml up -d postgres_db

# 4. Restore sebagai role aplikasi
docker compose -f docker-compose.prod.yml exec -T postgres_db \
  pg_restore -U "${DB_USER:-app_user}" -d "${DB_NAME:-app_db}" --no-owner --no-privileges --exit-on-error < backup.dump

# 5. Nyalakan sisanya dan verifikasi
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec backend_app npx prisma migrate status
```

Simpan `backup.dump` sampai verifikasi selesai. Langkah 2 menghapus data lama; jangan jalankan
sebelum `backup.dump` terverifikasi bisa dibaca (`pg_restore --list backup.dump`).

## Yang TIDAK diubah

- Port 5432 dan 6379 pada `docker-compose.yml` (dev) masih dipublikasikan ke semua interface
  (`0.0.0.0`). Itu temuan terpisah.
- `docker-compose.monitoring.yml` terhubung sebagai `DB_USER` (non-superuser), jadi `postgres_exporter`
  hanya melihat statistik yang boleh dilihat role biasa. Beri `pg_monitor` kalau butuh lebih.
