# Blue-Green Deployment (Kelompok 2, item 2.8) — VPS

> Untuk strategi Kubernetes (Phase 20), lihat `k8s/README.md` §
> "Blue-Green Deployment" & "Canary Deployment" — desain terpisah,
> belum diverifikasi lewat cluster sungguhan (butuh `kind`/`minikube`
> atau cluster nyata, di luar jangkauan sandbox AI ini maupun VPS
> yang didokumentasikan di sini).

## TEMUAN T20 — cacat direktori bersama (diperbaiki)

Audit ulang (hasil kerja sesi AI paralel sebelumnya WAJIB diverifikasi
lagi sebelum dipercaya — lihat aturan kerja proyek ini) menemukan
cacat nyata di desain awal: `deploy-blue-green.sh` dan kedua file PM2
(`ecosystem.config.js`/`ecosystem.green.config.js`) memakai
`cwd: __dirname + '/../..'` — SATU direktori project yang sama untuk
blue maupun green, cuma port & nama proses PM2 yang beda. Step build
skrip (`git pull`/`npm ci`/`prisma migrate deploy`/`npm run build`)
berjalan SEKALI di direktori itu, SEBELUM instance standby sempat
lolos health check.

**Dibuktikan nyata** (cluster PM2 2-instance sungguhan meniru "blue",
traffic HTTP kontinu, di direktori shared): setelah build "green"
menimpa `dist/server.js` di direktori yang sama — SAAT blue masih
aktif dan belum disentuh script sama sekali — satu worker blue
di-`kill` (meniru `max_memory_restart` atau crash biasa, BUKAN
tindakan deploy). PM2 me-restart worker itu, dan ia langsung
menjalankan kode BARU yang belum pernah lolos health check. Traffic
"blue" pecah jadi dua versi campur aduk secara diam-diam, tanpa nginx
atau health-gate script ikut campur sama sekali.

**Perbaikan:** blue & green sekarang WAJIB dua direktori clone git
terpisah — build hanya pernah menyentuh direktori STANDBY; direktori
ACTIVE (yang masih melayani traffic nyata) tidak disentuh sama sekali
sampai traffic benar-benar sudah di-switch. Script menolak
(fail-closed) kalau `BLUE_APP_DIR`/`GREEN_APP_DIR` tidak ada, bukan
clone git sendiri, atau menunjuk ke path fisik yang sama.

**Batas yang TIDAK diubah, jujur diakui:** `prisma migrate deploy`
tetap berjalan di step build (direktori standby), SEBELUM standby
lolos health check. Kalau migration itu tidak backward-compatible
dengan kode yang MASIH AKTIF, dan standby kemudian gagal health check,
pesan skrip "traffic tetap aman di $ACTIVE_COLOR" tidak sepenuhnya
benar — migration TIDAK ikut dibatalkan. Ini keterbatasan desain
online-migration yang sama dengan yang sudah didokumentasikan di
`rollback.sh` (skema DB tidak di-rollback otomatis) — bukan sesuatu
yang bisa diselesaikan hanya dengan memisahkan direktori, dan di luar
scope perbaikan T20 ini. Kalau butuh migration yang aman untuk
blue-green sungguhan, migration harus ditulis dengan pola
expand/contract (kolom baru nullable dulu, kode lama & baru sama-sama
jalan, baru drop kolom lama di rilis berikutnya) — keputusan per-migration,
bukan sesuatu yang bisa dipaksakan otomatis oleh script deploy.

## Setup sekali di awal (WAJIB sebelum pakai `deploy-blue-green.sh`)

```bash
# Dua clone TERPISAH — bukan satu direktori yang dipakai bersama.
sudo git clone <url-repo-anda> /var/www/backend-foundation-blue
sudo git clone <url-repo-anda> /var/www/backend-foundation-green
cd /var/www/backend-foundation-blue && cp /path/ke/.env.production .env
cd /var/www/backend-foundation-green && cp /path/ke/.env.production .env
# .env boleh identik di kedua direktori (PORT tidak perlu diisi di .env —
# masing-masing ecosystem.*.config.js sudah menetapkan PORT sendiri lewat
# blok `env:`, yang mengalahkan nilai dari .env untuk proses PM2 itu).
```

Bawa **blue** online dulu (`npm ci && npx prisma generate && npx prisma
migrate deploy && npm run build && pm2 start deploy/pm2/ecosystem.config.js`
di dalam `/var/www/backend-foundation-blue`), arahkan nginx ke situ
seperti deploy biasa. **Baru setelah itu** pasang config nginx
blue-green (lihat "Cara pakai" di bawah) dan mulai pakai
`deploy-blue-green.sh` untuk deploy berikutnya — script itu sendiri
TIDAK melakukan clone/setup awal, hanya mengelola switch antara dua
direktori yang sudah ada.

`BLUE_APP_DIR`/`GREEN_APP_DIR` bisa dioverride lewat env var kalau
tidak memakai path default (`/var/www/backend-foundation-blue`/`-green`,
konsisten dengan konvensi `/var/www/backend-foundation` yang dipakai
`deploy.sh` biasa).

## Yang ditambahkan (sebelum T20)

- `deploy/pm2/ecosystem.green.config.js` — instance kedua ("green"),
  port 3001, terpisah dari `ecosystem.config.js` utama ("blue", port
  implisit dari `.env`) — SENGAJA file terpisah (bukan digabung
  permanen), konsisten dengan keputusan yang sudah ada: blue-green
  butuh kapasitas 2x lipat, keputusan operasional sadar, bukan
  otomatis tiap deploy biasa.
- `deploy/scripts/deploy-blue-green.sh` — otomatisasi PENUH: deteksi
  warna aktif (dari baris `backup` di nginx conf), deploy kode ke
  instance standby, health-check LANGSUNG ke standby (bypass nginx),
  swap baris `backup` di nginx conf, `nginx -t` + reload, verifikasi
  pasca-switch. **Fail-closed**: kalau standby tidak pernah `/ready`,
  script berhenti — nginx TIDAK PERNAH diubah.

## Verifikasi nyata yang sudah dijalankan

**Batasan jujur**: sandbox AI ini tidak bisa menjalankan app
sesungguhnya (Prisma Client blocked, sama seperti item-item lain).
Jadi drill dijalankan berlapis:

**Lapis 1 — drill dengan stand-in app** (Express minimal + PM2 + nginx
SUNGGUHAN, traffic HTTP kontinu SUNGGUHAN), 9/9 pengecekan lolos:
zero-downtime terbukti, transisi bersih (tidak ada traffic nyasar
campur aduk), rollback instan berhasil tanpa restart proses app,
abort otomatis kalau standby tidak pernah `/ready` terbukti tidak
mengubah nginx sama sekali.

**Lapis 2 — script PRODUKSI ASLI** (`deploy-blue-green.sh` apa adanya,
langkah `git`/`npm`/`npx`/`pm2`/`sudo`/`nginx`/`systemctl` diganti stub
yang mencatat argumen & cwd), dijalankan terhadap DUA direktori
terpisah sungguhan: (a) alur sukses membuktikan build HANYA menyentuh
direktori standby — direktori active tidak pernah tersentuh, dibuktikan
lewat file sentinel yang isinya tetap sama persis sebelum/sesudah; (b)
fail-closed kalau `BLUE_APP_DIR`/`GREEN_APP_DIR` tidak ada; (c)
fail-closed kalau keduanya menunjuk path fisik yang sama (realpath);
(d) abort tanpa mengubah nginx kalau standby tidak pernah `/ready` —
perilaku ini TIDAK berubah dari sebelum T20. Dikemas ulang sebagai
`src/shared/security/blue-green-scripts.spec.ts` (pola sama seperti
`dr-scripts.spec.ts` milik temuan T19), dilewati di Windows.

**Yang BELUM diverifikasi** (butuh VPS/staging sungguhan dengan dua
clone git nyata): `git pull`/`npm ci`/`prisma migrate deploy`/`npm run
build` sungguhan (perlu source control + Prisma Client sungguhan) di
dalam topologi dua-direktori yang baru, dan `sudo systemctl reload
nginx` (perlu nginx sebagai system service sungguhan). Skenario
"worker aktif autorestart di tengah build standby" yang membuktikan
T20 dijalankan terhadap stand-in app di sandbox — BELUM direproduksi
ulang dengan app sesungguhnya di VPS nyata, meski perbaikannya
(isolasi direktori) bersifat struktural jadi tidak bergantung pada
app-nya.

## Cara pakai (production, sekali pasang)

1. Selesaikan "Setup sekali di awal" di atas (dua direktori clone).
2. Di `deploy/nginx/backend-foundation.conf`, ganti KEDUA baris
   `proxy_pass http://127.0.0.1:3000;` (location `/health` dan `/`)
   menjadi `proxy_pass http://backend_blue_green;`.
3. Tambahkan isi `backend-foundation.blue-green.conf.example`
   (hilangkan komentar prosedur manual kalau mau, sudah tidak
   relevan lagi) ke `backend-foundation.conf`, atau `include` sebagai
   file terpisah.
4. `sudo nginx -t && sudo systemctl reload nginx`.
5. Deploy berikutnya, pakai `deploy/scripts/deploy-blue-green.sh`
   alih-alih `deploy.sh` biasa.

## Canary — belum diimplementasi di VPS

Roadmap item 2.8 menyebut "blue-green/canary" — canary (membagi
PERSENTASE traffic ke dua versi sekaligus, bukan switch 100%
sekaligus) jauh lebih natural dilakukan lewat load balancer yang
mendukung weighted routing (nginx Plus, HAProxy, atau ingress
controller Kubernetes — lihat `k8s/README.md`). nginx open-source
biasa (yang dipakai VPS project ini) tidak punya weighted upstream
built-in tanpa modul tambahan (`split_clients` bisa dipakai tapi
granularitasnya kasar, per-IP hash bukan per-request true percentage)
— diputuskan TIDAK diimplementasikan di VPS untuk iterasi ini, canary
sungguhan direkomendasikan lewat jalur Kubernetes yang sudah
terdokumentasi di `k8s/README.md`.
