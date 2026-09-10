# Monitoring Stack — Prometheus + Grafana

Stack observability tambahan untuk `backend-foundation`, terpisah dari
stack aplikasi utama (`docker-compose.yml` / `docker-compose.prod.yml`).
Lihat komentar di `docker-compose.monitoring.yml` untuk alasan
pemisahannya.

## Prasyarat

Stack utama HARUS sudah berjalan lebih dulu — jaringan `backend-network`
(dibuat oleh stack utama) dipakai bersama oleh Prometheus, Grafana, dan
ketiga exporter di sini untuk menjangkau `backend_app`, `redis`,
`postgres_db`, dan host itu sendiri (`node_exporter`, Phase 20).

## Menjalankan

```bash
# 1. Stack utama (kalau belum jalan)
docker compose up -d

# 2. Stack monitoring
docker compose -f docker-compose.monitoring.yml up -d
```

## Mengakses

| Layanan    | URL                      | Keterangan                                   |
| ---------- | ------------------------ | --------------------------------------------- |
| Prometheus | http://localhost:9090    | Query PromQL langsung, cek status target scrape di `/targets` |
| Grafana    | http://localhost:3001    | Login awal `admin` / `admin` (ganti lewat `GRAFANA_ADMIN_PASSWORD` di `.env` untuk production) |
| Alertmanager | http://localhost:9093  | Lihat alert yang sedang firing/silenced — lihat § Alerting di bawah |

Dashboard **"Backend Foundation — Overview"** sudah ter-provisioning
otomatis (folder Grafana: *Backend Foundation*) — tidak perlu import
manual. Berisi:

- API request rate per route
- Error rate (%)
- Request latency p50/p95/p99
- CPU usage proses
- Memory usage (RSS + heap)
- Event loop delay
- Status Redis (`redis_up`) & PostgreSQL (`pg_up`)
- Active requests & process uptime

## Menambah panel/dashboard baru

Edit atau tambah file JSON di `monitoring/grafana/dashboards/` — Grafana
mem-polling folder ini setiap 30 detik (`updateIntervalSeconds` di
`provisioning/dashboards/dashboards.yml`) dan otomatis memuat ulang
tanpa perlu restart container.

## Alerting

`monitoring/prometheus/alerts.yml` — dikirim ke Alertmanager
(`http://localhost:9093`), diteruskan ke `/api/v1/internal/alertmanager-webhook`
(lihat `alertmanager-webhook.controller.ts` — mencatat ke Pino/Sentry;
ganti `receivers:` di `monitoring/alertmanager/alertmanager.yml` ke
Slack/PagerDuty/email sungguhan untuk production). Cakupan (Phase 13 +
Phase 20):

- **Application**: error budget burn-rate (fast & slow), p95 latency
  di atas SLO, `ServiceDown`.
- **Database**: `PostgresDown` (koneksi), `PostgresQueryLatencyHigh`
  (transaksi berjalan lama — lihat catatan kejujuran soal metrik
  default exporter di `alerts.yml`).
- **Queue**: `QueueFailedJobsHigh`, `QueueStuck`, `QueueWorkerDown` —
  sumber metrik `src/shared/queue/queue.metrics.ts`.
- **Infrastructure**: `HostCpuUsageHigh`, `HostMemoryUsageHigh`,
  `HostDiskSpaceLow` — butuh `node_exporter` (service baru Phase 20,
  lihat catatan DaemonSet-untuk-Kubernetes di `docker-compose.monitoring.yml`
  kalau target deploy sungguhan bukan Docker Compose).

## Menghentikan

```bash
docker compose -f docker-compose.monitoring.yml down
```

Tambahkan `-v` kalau ingin ikut menghapus data historis Prometheus &
konfigurasi Grafana (`prometheus_data`, `grafana_data`).
