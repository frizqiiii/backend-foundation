# Blue-Green Deployment (Kelompok 2, item 2.8) — VPS

> Untuk strategi Kubernetes (Phase 20), lihat `k8s/README.md` §
> "Blue-Green Deployment" & "Canary Deployment" — desain terpisah,
> belum diverifikasi lewat cluster sungguhan (butuh `kind`/`minikube`
> atau cluster nyata, di luar jangkauan sandbox AI ini maupun VPS
> yang didokumentasikan di sini).

## Status sebelum item ini dikerjakan

`deploy/nginx/backend-foundation.blue-green.conf.example` sudah ada
sejak fase sebelumnya, tapi eksplisit disebut "PERSIAPAN" — 2 hal
yang disebutkan BELUM ada: (1) config PM2 kedua untuk instance
"green", (2) prosedur switch masih MANUAL (edit file nginx dengan
tangan). Item ini melengkapi keduanya + memverifikasinya nyata.

## Yang ditambahkan

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
Jadi drill dijalankan 2 lapis:

**Lapis 1 — drill dengan stand-in app** (`chaos-test`-style: Express
minimal + PM2 + nginx SUNGGUHAN, traffic HTTP kontinu SUNGGUHAN),
9/9 pengecekan lolos:
- Zero-downtime terbukti: puluhan request selama switch, NOL yang
  gagal/timeout.
- Transisi bersih: traffic SEBELUM switch 100% versi lama, SETELAH
  switch 100% versi baru — tidak ada traffic "nyasar" campur aduk.
- Rollback instan (switch balik) berhasil tanpa restart proses app.
- **Abort otomatis**: kalau instance baru sengaja dibuat tidak pernah
  `/ready`, script berhenti — nginx TERBUKTI tidak berubah sama
  sekali, traffic tetap 100% ke versi lama.

**Lapis 2 — script PRODUKSI ASLI** (`deploy/scripts/deploy-blue-green.sh`
apa adanya, cuma langkah yang butuh production sungguhan yang
di-stub: `git pull`/`npm ci`/`prisma generate`/`sudo systemctl`),
dijalankan DUA ARAH (blue→green DAN green→blue) terhadap infrastruktur
lapis 1 di atas — **berhasil bidirectional**, membuktikan logic
deteksi-warna & swap `backup`-nya (bagian yang PALING mungkin salah
ketik/salah logic) benar.

**Yang BELUM diverifikasi** (butuh VPS/staging sungguhan): langkah
`git pull`/`npm ci`/`prisma migrate deploy`/`npm run build` di dalam
script (perlu source control + Prisma Client sungguhan), dan
`sudo systemctl reload nginx` (perlu nginx sebagai system service
sungguhan, bukan proses standalone seperti di drill).

## Cara pakai (production, sekali pasang)

1. Di `deploy/nginx/backend-foundation.conf`, ganti KEDUA baris
   `proxy_pass http://127.0.0.1:3000;` (location `/health` dan `/`)
   menjadi `proxy_pass http://backend_blue_green;`.
2. Tambahkan isi `backend-foundation.blue-green.conf.example`
   (hilangkan komentar prosedur manual kalau mau, sudah tidak
   relevan lagi) ke `backend-foundation.conf`, atau `include` sebagai
   file terpisah.
3. `sudo nginx -t && sudo systemctl reload nginx`.
4. Deploy berikutnya, pakai `deploy/scripts/deploy-blue-green.sh`
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
