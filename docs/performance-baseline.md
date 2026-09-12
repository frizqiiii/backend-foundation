# Performance Baseline

> Diisi lewat run nyata `k6 run performance-tests/benchmark.js` — BUKAN
> perkiraan. Update bagian ini tiap kali ada perubahan besar (migrasi
> database, upgrade dependency besar, dst) dengan run baru, supaya
> selalu ada pembanding "apakah ini jadi lebih lambat dibanding rilis
> sebelumnya?" (lihat rationale metodologi lengkap di komentar
> `performance-tests/benchmark.js`).

## Run #1 — 2026-09-12

**Kondisi environment saat run ini (PENTING, baca sebelum membandingkan run lain):**

- PostgreSQL: **UP** (native, port 5433)
- Redis: **SENGAJA DOWN** (`REDIS_URL` dikonfigurasi ke `localhost:6379`, tapi tidak ada proses Redis yang jalan) — ini bukan kecelakaan, run ini dilakukan tepat setelah sesi hardening reliability (Fase 1 item 1.5) yang menemukan & memperbaiki beberapa bug terkait Redis-down (lihat `docs/incident-log` atau riwayat commit terkait `retryStrategy`, `quietRedisQuit`, `passOnStoreError`).
- `k6`: 50 iterasi, `vus: 1` (baseline murni, bukan concurrency test — lihat `benchmark.js`)

**Hasil:**

| Endpoint | avg | p90 | p95 | max |
|---|---|---|---|---|
| `GET /health` | 5.42ms | 9.47ms | 10.61ms | 16.94ms |
| `GET /ready` | 3.01s | 3.01s | 3.02s | 3.02s |
| `GET /api/v1/events` | 6.18s | 6.16s | 6.16s | 8.75s |

`http_req_failed`: 0.00% (0/150) — semua request tetap dapat response (bukan connection error), sesuai desain fail-open yang baru diperbaiki.

**Interpretasi — INI BUKAN baseline "kondisi sehat", ini baseline "kondisi Redis down":**

1. `/health` (liveness) **tidak terpengaruh sama sekali** oleh Redis mati — sesuai desain (lihat komentar di `health.controller.ts`, sengaja tidak menyentuh dependency eksternal apa pun). Angka ini (~5-10ms) valid dipakai sebagai baseline liveness apa pun kondisi Redis.

2. `/ready` konsisten mentok di **~3 detik** — ini persis `timeoutMs` di `checkDependency()` (`health.controller.ts`) untuk pengecekan `queue.ping()`. Bukan bug, ini timeout yang memang di-desain, tapi **3 detik adalah biaya nyata per polling `/ready`** kalau dipakai orchestrator (Kubernetes readiness probe) — kalau interval probe lebih pendek dari ini, bisa terjadi antrian probe yang menumpuk.

3. `/api/v1/events` (mewakili endpoint bisnis biasa di balik `generalRateLimiter` + `tenantRateLimiter`) naik ke **rata-rata 6.18 detik** — ini biaya kumulatif dari KEDUA rate limiter yang masing-masing mencoba `redis.call()` (retry sampai `maxRetriesPerRequest: 2` tercapai) SEBELUM akhirnya fail-open (`passOnStoreError: true`, lihat `rate-limiter.ts`) dan meloloskan request. Aplikasi TIDAK down (0% request gagal), tapi **latensi per-request naik ~1200x lipat** (dari target <500ms p95 di `k6.config.js` jadi 6+ detik) selama Redis mati.

**Follow-up yang layak dipertimbangkan (BUKAN dikerjakan sekarang, di luar scope item 1.3 — cuma dicatat supaya tidak hilang):**
- Rate limiter saat ini retry ke Redis PER REQUEST saat Redis down — circuit breaker (sudah ada `shared/reliability/circuit-breaker.ts` di project ini untuk kasus lain) bisa menghentikan percobaan berulang itu setelah beberapa kegagalan beruntun, supaya request berikutnya langsung fail-open tanpa menunggu retry lagi.
- `/ready` timeout 3 detik untuk queue check mungkin terlalu lama untuk dipakai sebagai interval polling Kubernetes readiness probe default (biasanya 10 detik) — perlu dicek apakah ini jadi masalah nyata di deployment sungguhan (item 1.6).

**Run pembanding dengan Redis UP masih perlu dilakukan** untuk punya baseline "kondisi sehat" yang sesungguhnya (tujuan asli skrip ini) — catat di sini begitu dilakukan.

---

## Bug ditemukan & diperbaiki sebelum run ini bisa berhasil

`performance-tests/benchmark.js` sebelumnya **belum pernah berhasil dijalankan sama sekali** — threshold `benchmark_health_ms: ['count>=0']` tidak valid untuk metric tipe `Trend` di k6 (`count` bukan aggregation method yang didukung; yang didukung: `avg`/`min`/`max`/`med`/`p(N)`). k6 gagal start sebelum mengirim satu request pun. Fixed jadi `['avg>=0']` (commit terkait, tanggal run di atas).
