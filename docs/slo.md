# Service Level Objectives (SLO)

Phase 13 (Enterprise Observability). Dokumen ini adalah SUMBER
KEBENARAN untuk seluruh angka SLO yang dipakai di
`monitoring/prometheus/alerts.yml` dan
`monitoring/grafana/dashboards/slo-service-health.json` — kalau angka
di sini berubah, KEDUA file itu harus ikut diubah, dan sebaliknya.

## Apa itu SLI/SLO/Error Budget (untuk yang belum familiar)

- **SLI (Service Level Indicator)** — metrik yang BENAR-BENAR diukur.
  Contoh: persentase request yang tidak error.
- **SLO (Service Level Objective)** — target/ambang untuk SLI itu.
  Contoh: "99.9% request tidak error selama 30 hari".
- **Error Budget** — jarak antara SLO dan 100%. SLO 99.9% berarti
  error budget 0.1% — dalam 30 hari (43.200 menit), itu setara
  **43.2 menit** downtime/error yang "dianggarkan" dan boleh terjadi
  tanpa melanggar SLO. Error budget BUKAN target untuk dihabiskan
  sengaja — ini alat untuk memutuskan kapan tim boleh mengambil risiko
  (deploy lebih sering, eksperimen) vs kapan harus fokus stabilitas
  (budget sudah menipis).

## SLI yang dipakai proyek ini

### 1. Availability

**Definisi**: proporsi HTTP request yang BUKAN error, terhadap total
request.

```
availability = 1 - (sum(rate(http_errors_total[window])) / sum(rate(http_requests_total[window])))
```

**Apa yang dihitung sebagai "error"** — lihat `http_errors_total` di
`metrics.registry.ts`: SEMUA response dengan status code ≥400,
termasuk 4xx (client error). Ini KEPUTUSAN SADAR, bukan default yang
tidak dipikirkan: sebagian tim hanya menghitung 5xx sebagai error
untuk SLO availability (alasan mereka: 4xx adalah "kesalahan client",
bukan kegagalan service). Proyek ini memilih mengikutsertakan 4xx
karena tingkat 4xx yang tiba-tiba melonjak SERING kali justru gejala
bug di sisi server (mis. validasi yang berubah perilaku tak sengaja,
endpoint yang salah routing) — memisahkannya berisiko menyembunyikan
sinyal itu dari SLO. Trade-off yang disadari: SLO ini SEDIKIT lebih
ketat daripada kalau hanya menghitung 5xx.

**Target**: **99.9%** dalam window 30 hari (≈ 43.2 menit error budget
per bulan).

### 2. Latency

**Definisi**: p95 dari waktu respons HTTP (`http_request_duration_seconds`,
lihat `metrics.registry.ts`).

**Target**: **p95 < 300ms**.

Kenapa p95 (bukan rata-rata/p50) — rata-rata gampang tertutupi oleh
mayoritas request cepat, menyembunyikan pengalaman buruk yang dialami
sebagian kecil user. p95 tetap tidak seketat p99 (yang sangat rentan
noise dari outlier tunggal) — dipilih sebagai keseimbangan antara
representatif dan stabil.

## Kenapa multi-window, multi-burn-rate alerting (bukan threshold statis)

Lihat komentar lengkap di `monitoring/prometheus/alerts.yml`. Ringkasnya:

| Alert | Window pendek | Window panjang | `for:` | Arti |
|---|---|---|---|---|
| `ErrorBudgetBurnFast` | 5m | 1h | 2m | Budget 30 hari akan habis dalam **<2 hari** kalau berlanjut — critical, page segera |
| `ErrorBudgetBurnSlow` | 30m | 6h | 15m | Budget 30 hari akan habis dalam **<5 hari** — warning, cukup untuk direspons jam kerja berikutnya |

Kedua window (pendek DAN panjang) harus SAMA-SAMA melewati ambang
sebelum alert firing — window pendek untuk deteksi cepat, window
panjang untuk memastikan ini bukan sekadar lonjakan sesaat.

## Keterbatasan yang diketahui (disengaja, bukan terlewat)

- **Error budget "resmi" (30 hari) tidak sepenuhnya bisa dihitung dari
  Prometheus lokal** — retensi default `docker-compose.monitoring.yml`
  adalah 15 hari (lihat komentar di file itu). Dashboard SLO memakai
  window 24h untuk panel "Error Budget Remaining" sebagai proxy yang
  REALISTIS untuk setup default, bukan angka 30-hari yang sebenarnya
  dijanjikan SLO ini. Untuk akurasi penuh: naikkan
  `--storage.tsdb.retention.time` ke ≥30d, atau (lebih baik untuk
  jangka panjang) pakai `remote_write` ke storage seperti Thanos/
  Mimir/Grafana Cloud yang tidak dibatasi retensi lokal.
- **Alert rule ini belum divalidasi lewat `promtool` sungguhan** di
  lingkungan pengembangan ini (tidak ada akses jaringan ke image
  Docker Prometheus) — sudah divalidasi sebagai YAML yang well-formed,
  TAPI belum divalidasi PromQL-nya lewat `promtool check rules
  monitoring/prometheus/alerts.yml`. **WAJIB** jalankan perintah itu
  (atau `docker compose -f docker-compose.monitoring.yml up -d` lalu
  cek tab "Status → Rules" di Prometheus UI) sebelum mengandalkan
  alert ini di production.
- **Alertmanager webhook receiver (`alertmanager.yml`) memakai URL
  placeholder** — lihat komentar di file itu, WAJIB diganti sebelum
  dipakai di luar development lokal.
- SLO ini mencakup SELURUH endpoint API secara agregat, BELUM
  dipecah per-endpoint atau per-tenant (Phase 11). Endpoint dengan
  karakteristik sangat berbeda (mis. upload file besar vs endpoint
  CRUD ringan) saat ini berbagi satu SLO latency yang sama — evaluasi
  SLO per-kelompok endpoint adalah kandidat perbaikan lanjutan.

## Playbook singkat saat alert firing

1. **`ErrorBudgetBurnFast`/`ServiceDown`** — cek dashboard "SLO /
   Service Health" dan "Backend Foundation — Overview" di Grafana
   dulu untuk gambaran cepat. Cek log terbaru (`docker compose logs -f
   backend_app`, atau log aggregator production) — filter dengan
   `trace_id`/`req.id` (correlation ID, Phase 13) dari request yang
   errornya paling representatif untuk menelusuri satu request utuh.
   Kalau ada trace OpenTelemetry aktif (`OTEL_ENABLED=true`), cari
   trace ID yang sama di Jaeger UI untuk melihat span mana yang
   lambat/gagal.
2. **`LatencyP95AboveSLO`** — cek panel "Request Latency (p50/p95/p99)"
   di dashboard Overview untuk melihat apakah ini SELURUH endpoint atau
   satu endpoint tertentu yang mendominasi. Cek CPU/Memory panel di
   dashboard yang sama — latency tinggi sering berkorelasi dengan
   resource saturation.
3. **`RedisDown`/`PostgresDown`** — cek langsung container-nya
   (`docker compose ps`, `docker compose logs redis`/`postgres_db`).
   Ini SELALU critical karena hampir semua fitur (queue, cache, auth
   session) bergantung pada keduanya.
