# Backup & Restore Guide

## ⚠️ Catatan Penting: Dua Skrip Backup yang Tidak Kompatibel

Proyek ini punya **dua skrip backup berbeda** di lokasi berbeda,
format output BERBEDA — jangan tertukar:

| Skrip | Format output | Dipakai oleh |
|---|---|---|
| `scripts/backup-db.sh` | `.dump` (pg_dump custom format, `-F c`) | Manual/berdiri sendiri |
| `deploy/scripts/backup-db.sh` | `.sql.gz` (plain SQL + gzip, opsional upload S3) | `deploy/scripts/deploy.sh` (otomatis sebelum migration, Phase 14) |

`scripts/restore-db.sh` **hanya kompatibel dengan `scripts/backup-db.sh`**
(format `.dump`, pakai `pg_restore`). Untuk restore file `.sql.gz` dari
`deploy/scripts/backup-db.sh`, gunakan:
```bash
gunzip -c backup_20260731_120000.sql.gz | psql "$DATABASE_URL"
```

Ini adalah temuan audit yang SENGAJA didokumentasikan apa adanya,
bukan disatukan diam-diam — menyatukan keduanya adalah keputusan
arsitektur yang perlu ditinjau terpisah dari upgrade dokumentasi ini.

## ⚠️ WAJIB: role backup harus mem-bypass Row-Level Security (temuan T19)

Tabel `products`, `events`, `api_keys`, `webhook_endpoints`, dan `export_jobs` memakai `FORCE ROW LEVEL SECURITY`. Role
aplikasi (`DATABASE_URL`) TUNDUK pada RLS, sehingga:

- `pg_dump` dengan role aplikasi **gagal**: `query would be affected by row-level security policy for table "api_keys"`.
- Jalan pintas yang tampak masuk akal, `pg_dump --enable-row-security`, **berhasil tetapi menghasilkan backup KOSONG** untuk
  semua tabel itu. Sebelum T19, skrip verifikasi lalu menyatakannya "TERVERIFIKASI valid" karena metadata (dihitung oleh
  role yang sama) juga mencatat 0. Terbukti di PostgreSQL 16 sungguhan: sumber punya 1 baris `products`, backup dan
  hasil restore 0, verifikasi lulus.

**Buat role khusus backup** (sekali, oleh superuser), lalu isi `BACKUP_DATABASE_URL`:

```sql
CREATE ROLE backup_role LOGIN PASSWORD '<password-kuat>' NOSUPERUSER BYPASSRLS;
GRANT pg_read_all_data TO backup_role;   -- PostgreSQL 14+: SELECT pada semua tabel
```

```bash
BACKUP_DATABASE_URL="postgresql://backup_role:<password>@host:5432/app_db" ./scripts/backup-db.sh
```

`backup-db.sh` sekarang memeriksa role itu SEBELUM membuat backup dan berhenti dengan pesan yang jelas kalau role-nya
tunduk pada RLS. Tanpa `BACKUP_DATABASE_URL`, skrip memakai `DATABASE_URL` dari `.env` dan menerapkan pemeriksaan yang sama.
`verify-backup.sh` dan `restore-db.sh` juga butuh role yang bisa menulis semua tabel (superuser atau `BYPASSRLS` yang
memiliki objeknya); `verify-backup.sh` menghitung baris dengan `row_security=off`, jadi role yang tunduk RLS menghasilkan
`[GAGAL]` yang terlihat, bukan angka 0 palsu.

Perubahan lain pada skrip DR (T19): file backup dan `.meta` berizin `0600` (direktori `0700`; sebelumnya `0644`/`0755`,
terbaca semua user di VPS); metadata mencakup `api_keys`, `webhook_endpoints`, `export_jobs`; `verify-backup.sh` menolak
`VERIFY_DATABASE_URL` yang menunjuk ke database YANG SAMA dengan production walau ejaan URL-nya berbeda (sebelumnya hanya
pembanding string: `localhost` vs `127.0.0.1` lolos, `pg_restore --clean` menimpa production dan 5 baris data baru hilang);
`restore-db.sh` tidak lagi mencetak password di prompt konfirmasi.

**Batas yang masih ada (tidak diubah):** (1) `pg_dump --dbname="$URL"` menaruh password di argumen proses, terlihat lewat `ps`
oleh user lokal selama dump berjalan; gunakan `~/.pgpass`/`PGPASSFILE` bila hostnya dibagi. (2) Angka di `.meta` dihitung
SETELAH dump selesai, bukan dari snapshot yang sama, jadi pada database yang aktif menulis bisa berbeda tipis dari isi dump
dan memicu `[GAGAL]` palsu. (3) `ENV_FILE` berakhir baris CRLF akan merusak URL yang dibaca skrip (edit `.env` di Linux).

## Backup Manual

```bash
# Format .dump (scripts/backup-db.sh) — baca DATABASE_URL dari .env
./scripts/backup-db.sh
# hasil: ./backups/backup_<timestamp>.dump

# Format .sql.gz (deploy/scripts/backup-db.sh) — baca dari environment,
# opsional upload S3
DATABASE_URL="postgresql://..." BACKUP_S3_BUCKET="nama-bucket" \
  ./deploy/scripts/backup-db.sh
```

## Backup Otomatis

**Sebelum setiap deploy** (Phase 14 upgrade) — `deploy/scripts/deploy.sh`
menjalankan `deploy/scripts/backup-db.sh` SEBELUM `prisma migrate deploy`,
otomatis, tanpa perlu langkah manual terpisah.

**Terjadwal harian** — cron (lihat `deploy/README.md` §6):
```
0 2 * * * cd /var/www/backend-foundation && set -a && source .env && set +a \
  && ./deploy/scripts/backup-db.sh >> /var/log/backend-foundation-backup.log 2>&1
```

Retensi otomatis: file lokal lebih tua dari `BACKUP_RETENTION_DAYS`
(default 7 untuk `deploy/scripts/`, 14 untuk `scripts/`) dihapus
otomatis setiap kali skrip berjalan.

## Restore

```bash
# Format .dump
./scripts/restore-db.sh backups/backup_20260731_120000.dump

# Format .sql.gz
gunzip -c backup_20260731_120000.sql.gz | psql "$DATABASE_URL"
```

**Sebelum restore ke database production**: pastikan Anda benar-benar
menimpa database yang tepat — `restore-db.sh` (kalau mengikuti pola
skrip serupa di proyek ini) tidak melakukan konfirmasi interaktif
tambahan. Uji dulu di database staging/kosong kalau ragu.

## Disaster Recovery — Skenario Umum

| Skenario | Langkah |
|---|---|
| Migration baru merusak data | `./deploy/scripts/rollback.sh` (kembalikan KODE) + restore manual dari backup pre-migration (lihat Phase 14 upgrade — backup otomatis dibuat SEBELUM setiap migration) |
| Database corrupt/hilang total | Provision instance PostgreSQL baru → restore backup TERBARU → jalankan `prisma migrate deploy` untuk migration yang terjadi SETELAH backup itu dibuat (kalau ada) |
| Perlu rollback ke versi kode N hari lalu tanpa masalah data | `git checkout <commit-lama>` manual, TIDAK perlu restore database sama sekali |

## Verifikasi Backup Benar-Benar Bisa Dipakai (Otomatis)

**Jangan berasumsi backup valid hanya karena skrip selesai tanpa
error** — file yang korup bisa saja tetap "berhasil" ditulis.

`scripts/verify-backup.sh` (Phase 20) mengotomasi verifikasi ini —
merestore backup ke database TERPISAH lalu membandingkan jumlah baris
tabel kunci (`users`, `events`, `products`) dengan angka YANG DIREKAM
`backup-db.sh` PERSIS saat backup itu dibuat (sidecar `<backup>.dump.meta`,
BUKAN dibandingkan dengan production saat ini — datanya sudah pasti
berbeda karena waktu terus berjalan sejak backup dibuat):

```bash
VERIFY_DATABASE_URL="postgresql://user:pass@host:5432/verify_db" \
  ./scripts/verify-backup.sh                                  # backup TERBARU di ./backups/
VERIFY_DATABASE_URL="postgresql://..." \
  ./scripts/verify-backup.sh ./backups/backup_20260806_020000.dump
```

`VERIFY_DATABASE_URL` **wajib** menunjuk ke database kosong/disposable
khusus verifikasi — skrip menolak berjalan kalau kosong ATAU kebetulan
sama dengan `DATABASE_URL` production (lihat komentar di skrip),
karena `pg_restore --clean` di dalamnya bersifat destruktif terhadap
database tujuan. **Prasyarat**: database tujuan itu sendiri harus
SUDAH ADA (`createdb nama_db_verifikasi`) sebelum skrip dijalankan —
`pg_restore` mengisi database yang sudah ada, bukan membuat database
baru dari nol. Kalau belum ada, skrip akan gagal jelas dengan pesan
`database "..." does not exist` (bukan gagal diam-diam).

Exit code bukan-nol kalau backup terbukti tidak valid — cocok
dijadwalkan cron/CI bulanan sebagai trigger alert (belum ada
scheduling bawaan di repo ini, tinggal ditambahkan ke `crontab`
server yang sama dengan §"Backup Otomatis" di atas):
```
0 3 1 * * cd /var/www/backend-foundation && set -a && source .env && set +a \
  && VERIFY_DATABASE_URL="$BACKUP_VERIFY_DATABASE_URL" ./scripts/verify-backup.sh \
  >> /var/log/backend-foundation-backup-verify.log 2>&1
```

**Catatan**: hanya kompatibel dengan format `.dump` dari
`scripts/backup-db.sh` (sama seperti `scripts/restore-db.sh`) — TIDAK
menangani `.sql.gz` dari `deploy/scripts/backup-db.sh`, konsisten
dengan catatan "dua skrip backup tidak kompatibel" di atas. Backup
lama yang dibuat SEBELUM kapabilitas ini ditambahkan tidak punya
sidecar `.meta` dan tidak bisa diverifikasi otomatis (skrip akan
menolak dengan pesan jelas, bukan diam-diam melewatkan).
