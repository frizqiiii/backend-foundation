# Performance Test (Phase 12 + Phase 21)

Skrip [k6](https://k6.io) untuk mengukur performa. Dua kelompok:

**Load Test (Phase 12 + Phase 20)** — lima alur paling kritis: login, CRUD Event, CRUD Product, CRUD User, dan upload file. Menaikkan beban bertahap ke level "normal" (puncak 100 VU) untuk memverifikasi target performa terpenuhi.

**Async/Queue Test (Langkah 5 audit)** — `export-queue-load.js`: SATU-SATUNYA skrip di sini yang mengukur alur ASYNC lewat BullMQ (enqueue → worker memproses → polling status), bukan request sinkron seperti skrip lain. Lihat komentar lengkap di file-nya untuk alasan kenapa concurrency-nya jauh lebih rendah.

**Enterprise Quality (Phase 21)** — empat skrip TAMBAHAN, tujuan berbeda-beda:

| Skrip | Tujuan | Beban |
|---|---|---|
| `benchmark.js` | Baseline latency untuk dibandingkan antar-rilis | 1 VU, 50 iterasi (TANPA persaingan resource) |
| `stress-test.js` | Cari titik jebol sistem | Naik bertahap sampai 500 VU (jauh di atas normal) |
| `spike-test.js` | Uji lonjakan traffic MENDADAK | 10 → 400 VU dalam 10 detik |
| `soak-test.js` | Cari memory leak/degradasi seiring waktu | 30 VU konstan, durasi lama (default 15 menit, bisa jam-jaman) |

k6 **bukan** package npm — ini binary terpisah yang menjalankan JavaScript-nya sendiri (bukan Node.js),
jadi tidak ada `node_modules` yang terlibat di sini.

## Instalasi k6

```bash
# macOS
brew install k6

# Ubuntu/Debian
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker (tanpa instalasi lokal)
docker run --rm -i --network host grafana/k6 run - < performance-tests/login-load.js
```

## Prasyarat

`login-load.js`, `event-crud-load.js`, `product-crud-load.js`, `upload-load.js` butuh akun test yang **sudah ada dan sudah terverifikasi
email** di database target — `AuthService.login` menolak akun belum
verifikasi (lihat `auth.service.ts`), dan skrip-skrip ini SENGAJA tidak
mendaftarkan akun sendiri (proses registrasi mengantre email verifikasi
yang bukan bagian dari yang diukur). `user-crud-load.js` adalah
PENGECUALIAN — SATU-SATUNYA skrip yang justru mendaftarkan akun baru
sendiri di dalam loop (lihat catatan lengkap di file-nya kenapa: modul
`users` tidak punya endpoint create/update, jadi siklus yang sungguhan
diukur adalah create-via-register lalu admin membacanya lagi. Siapkan
akun test lewat `prisma db seed` atau mendaftar manual lalu verifikasi
manual di database:

| Skrip | Role akun yang dibutuhkan |
|---|---|
| `login-load.js` | Bebas (role apa pun) |
| `event-crud-load.js` | ORGANIZER atau ADMIN (butuh permission `event.create`) |
| `product-crud-load.js` | ORGANIZER atau ADMIN (butuh permission `product.create`) |
| `user-crud-load.js` | ADMIN (butuh permission `user.manage` untuk list + delete) |
| `upload-load.js` | Bebas (semua role punya `upload.create`) |
| `export-queue-load.js` | **ADMIN** (satu-satunya skrip yang butuh `dashboard.read` — permission ini HANYA dimiliki ADMIN, lihat `permissions.ts`) |

`benchmark.js`, `stress-test.js`, `spike-test.js`, `soak-test.js` (Phase 21) **TIDAK butuh akun test** — sengaja menyasar endpoint publik (`/health`, `/ready`, `GET /api/v1/events`) supaya bisa langsung dijalankan tanpa setup data, dan supaya beban yang diukur murni kapasitas HTTP/Express, tidak tercampur biaya autentikasi.

## Menjalankan

```bash
npm run perf:login       # atau: k6 run performance-tests/login-load.js
npm run perf:event-crud
npm run perf:product-crud
npm run perf:user-crud   # butuh akun ADMIN — lihat tabel di atas
npm run perf:upload
npm run perf:export      # Langkah 5 audit — butuh akun ADMIN, lihat tabel di atas
npm run perf:benchmark   # Phase 21
npm run perf:stress      # Phase 21 — BUKAN untuk dijalankan ke production, cuma staging/local
npm run perf:spike       # Phase 21 — sama, staging/local saja
npm run perf:soak        # Phase 21 — durasi lama, jalankan di background/CI terjadwal
```

Override target/kredensial lewat `-e`:

```bash
k6 run -e BASE_URL=https://staging.example.com \
       -e LOGIN_EMAIL=loadtest@example.com \
       -e LOGIN_PASSWORD='Password123' \
       performance-tests/login-load.js

k6 run -e BASE_URL=https://staging.example.com -e SOAK_DURATION=4h performance-tests/soak-test.js
```

## Target & Interpretasi Hasil

**Load Test & Soak Test**: sesuai spesifikasi upgrade, **95th percentile (p95) response time
< 500ms**, error rate < 1%. Threshold ini diperiksa OTOMATIS oleh k6 — kalau
dilanggar, k6 keluar dengan exit code bukan-nol (berguna sebagai
gate di CI/CD, lihat Phase 13).

**Stress Test & Spike Test**: threshold SENGAJA longgar (p95<3000ms) — tujuannya BUKAN lulus/gagal, melainkan mengamati angka sesungguhnya di laporan akhir k6 untuk memahami perilaku sistem di batas kapasitas. Baca laporan lengkapnya, jangan cuma lihat exit code.

**Benchmark**: TIDAK ada threshold pass/fail — simpan angka `benchmark_*_ms` (p50/p90/p99) dari tiap run sebagai catatan, bandingkan manual antar rilis.

Metrik utama yang dilaporkan k6 di akhir run:
- `http_req_duration` (avg/min/max/p90/p95) — response time.
- `http_reqs` (per detik) — throughput.
- `http_req_failed` (rate) — error rate.
- `vus`/`vus_max` — concurrent user tercapai.

## Batasan yang Perlu Diketahui

Skrip ini menguji **satu instance aplikasi secara langsung** — Redis
rate limiter (`shared/security/rate-limiter.ts`) yang sudah ada di
aplikasi ini KEMUNGKINAN BESAR akan menolak sebagian request begitu
beban naik (ini justru perilaku yang BENAR di produksi, bukan bug) —
untuk `stress-test.js`/`spike-test.js` ini SENGAJA dibiarkan aktif
(bagian dari yang diuji: apakah rate limiter melindungi sistem
dengan benar di beban ekstrem). Kalau tujuan run adalah mengukur
performa murni tanpa terpengaruh rate limiter, naikkan sementara
batasnya di environment test — JANGAN
menonaktipkan rate limiter di produksi.

