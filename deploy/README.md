# Deployment Runbook — Ubuntu VPS

> **Catatan jujur:** panduan ini disusun dan setiap skrip/config di
> dalamnya **diuji sebisa mungkin** (lihat catatan verifikasi di
> setiap bagian), tapi saya tidak punya akses ke VPS/domain/DNS
> sungguhan untuk benar-benar menjalankan deployment end-to-end.
> Ikuti langkah-langkah ini di server Anda sendiri; setiap perintah
> di bawah adalah perintah nyata yang bisa langsung disalin-tempel.

## 1. Persiapan Server (Ubuntu 22.04/24.04 VPS)

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Redis
sudo apt install -y redis-server

# Nginx
sudo apt install -y nginx

# PM2 (global)
sudo npm install -g pm2

# Firewall dasar — hanya SSH, HTTP, HTTPS yang terbuka ke publik
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 2. Setup Database

```bash
sudo -u postgres psql -c "CREATE USER app_user WITH PASSWORD 'ganti-password-kuat';"
sudo -u postgres psql -c "CREATE DATABASE app_db OWNER app_user;"
```

Isi `DATABASE_URL` di `.env` production:
```
DATABASE_URL="postgresql://app_user:ganti-password-kuat@localhost:5432/app_db?schema=public"
```

## 3. Clone & Build Aplikasi

```bash
git clone <url-repo-anda> /var/www/backend-foundation
cd /var/www/backend-foundation
npm ci
cp .env.example .env
nano .env   # isi semua kredensial production yang sebenarnya
npx prisma generate
npx prisma migrate deploy   # menjalankan migration/, BUKAN `migrate dev`
npm run build
mkdir -p logs
```

`migrate deploy` (bukan `migrate dev`) sengaja dipakai — ini yang aman
untuk production: menerapkan migration yang sudah ada tanpa
interaktif/prompt apa pun.

## 4. Jalankan Aplikasi Lewat PM2

```bash
pm2 start deploy/pm2/ecosystem.config.js
pm2 save                 # simpan daftar proses supaya bangkit lagi setelah reboot
pm2 startup              # ikuti instruksi yang ditampilkan (jalankan sebagai root)
pm2 status               # cek kedua proses (api + worker) status "online"
pm2 logs backend-foundation-api    # tail log real-time
```

## 5. Nginx + Domain + SSL (Let's Encrypt)

```bash
sudo cp deploy/nginx/backend-foundation.conf /etc/nginx/sites-available/
# Ganti "api.example.com" di file itu dengan domain Anda:
sudo sed -i 's/api.example.com/domain-anda.com/g' /etc/nginx/sites-available/backend-foundation.conf
sudo ln -s /etc/nginx/sites-available/backend-foundation.conf /etc/nginx/sites-enabled/
sudo nginx -t             # WAJIB — pastikan tidak ada syntax error sebelum reload
sudo systemctl reload nginx

# Certbot — otomatis mengurus sertifikat DAN mengedit config Nginx
# (menambah ssl_certificate, mengubah block :80 jadi redirect)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d domain-anda.com

# Verifikasi auto-renewal (Certbot sudah pasang systemd timer otomatis)
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

Pastikan domain Anda sudah punya **A record** yang mengarah ke IP VPS
ini SEBELUM menjalankan `certbot` — Let's Encrypt akan gagal
verifikasi kalau DNS belum aktif.

## 6. Strategi Backup Database

```bash
chmod +x deploy/scripts/backup-db.sh

# Uji manual dulu sebelum dijadwalkan
DATABASE_URL="postgresql://app_user:ganti-password-kuat@localhost:5432/app_db" \
  BACKUP_S3_BUCKET="nama-bucket-backup-anda" \
  ./deploy/scripts/backup-db.sh

# Jadwalkan lewat cron — setiap hari jam 2 pagi
crontab -e
# Tambahkan baris:
# 0 2 * * * cd /var/www/backend-foundation && set -a && source .env && set +a && ./deploy/scripts/backup-db.sh >> /var/log/backend-foundation-backup.log 2>&1
```

**Verifikasi nyata yang sudah saya lakukan** (bukan cuma menulis
skrip dan berasumsi benar) — dijalankan terhadap PostgreSQL
sungguhan yang saya instal di sandbox saya sendiri:
1. Buat tabel + isi data uji.
2. Jalankan `backup-db.sh` — hasilkan file `.sql.gz`.
3. Buka isi file terkompresi — **data uji benar-benar ada di dalamnya**.
4. **Restore** file itu ke database BARU yang kosong — data yang
   keluar **identik** dengan data asli.

Ini membuktikan skrip backup benar-benar bisa dipakai untuk restore
sungguhan, bukan cuma "berhasil jalan tanpa error" tapi filenya rusak.
`prisma migrate deploy` sendiri tetap tidak bisa saya uji di sandbox
saya — bukan karena masalah koneksi database (sudah terbukti
berfungsi normal di atas), tapi karena sandbox saya tidak diberi akses
ke `binaries.prisma.sh` (limitasi jaringan yang sama sejak awal
proyek ini) — jalankan `npx prisma migrate deploy` sendiri di server
Anda sebagai bagian dari langkah 3 di atas.

## 7. Update / Redeploy (Zero-Downtime, dengan Backup & Rollback Otomatis)

```bash
cd /var/www/backend-foundation
chmod +x deploy/scripts/deploy.sh deploy/scripts/rollback.sh   # sekali saja
./deploy/scripts/deploy.sh
```

`deploy.sh` (Phase 14 upgrade) menjalankan SATU alur lengkap, bukan
langkah manual terpisah seperti sebelumnya:
1. Mencatat commit saat ini ke `.last-known-good-commit`.
2. **Backup database SEBELUM migration apa pun dijalankan** — kalau
   migration baru merusak data, ini jalur kembalinya.
3. `git pull` + `npm ci` + `prisma generate`.
4. `prisma migrate deploy` + `npm run build`.
5. `pm2 reload` — reload ZERO-DOWNTIME (cluster mode mematikan
   instance lama satu-per-satu sambil yang baru sudah menyala, bukan
   mematikan semua dulu).
6. Health check `GET /health` diulang sampai 10x — **rollback OTOMATIS
   ke commit sebelumnya** (`rollback.sh`) kalau semua percobaan gagal.

Rollback otomatis ini HANYA mengembalikan **kode**, bukan skema/data
database (lihat penjelasan lengkap kenapa di komentar `rollback.sh`)
— untuk itu, gunakan backup dari langkah 2 di atas secara manual.

### Rollback Manual

Kalau Anda perlu rollback tanpa menunggu deploy gagal (mis. baru sadar
ada bug setelah deploy sukses):

```bash
./deploy/scripts/rollback.sh
```

### Deploy Otomatis dari GitHub Actions

`.github/workflows/deploy.yml` menjalankan `deploy.sh` ini lewat SSH
setiap kali tag versi baru di-push (`git tag v1.4.0 && git push --tags`).
Butuh 3 repository secret: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (private
key SSH), dan `VPS_APP_PATH` (mis. `/var/www/backend-foundation`).

## 8. Blue/Green Deployment

Diimplementasikan penuh & terverifikasi (drill nyata: nginx + PM2
sungguhan, traffic HTTP kontinu, switch dua arah, zero-downtime
terbukti) — lihat `docs/blue-green-deployment.md` untuk hasil
lengkap & cara pasang. Ringkasan file:
- `deploy/pm2/ecosystem.green.config.js` — instance kedua ("green").
- `deploy/scripts/deploy-blue-green.sh` — otomatisasi switch, dipakai
  MENGGANTIKAN `deploy.sh` biasa kalau memilih strategi ini.
- `deploy/nginx/backend-foundation.blue-green.conf.example` —
  konfigurasi upstream yang dibutuhkan (pasang sekali).

**Tetap opsional/opt-in** — butuh kapasitas server 2x lipat selama
masa transisi, keputusan operasional yang harus sadar diambil, bukan
otomatis terpasang lewat `deploy.sh` reguler.

## 9. Checklist Keamanan Sebelum Go-Live

- [ ] `.env` production berisi `NODE_ENV=production` dan seluruh
      secret (JWT, DB, AWS) BUKAN nilai contoh/default
- [ ] `CORS_ALLOWED_ORIGINS` hanya berisi domain frontend asli,
      tanpa wildcard
- [ ] Port 5432 (Postgres) dan 6379 (Redis) TIDAK terbuka ke publik
      di firewall (`sudo ufw status` — hanya 22/80/443 yang perlu ada)
- [ ] `pm2 startup` sudah dikonfirmasi (aplikasi bangkit otomatis
      setelah VPS reboot)
- [ ] Cron backup sudah diuji sekali secara manual sebelum diandalkan
      berjalan otomatis
- [ ] `sudo certbot renew --dry-run` sukses (SSL tidak akan kedaluwarsa
      diam-diam)
