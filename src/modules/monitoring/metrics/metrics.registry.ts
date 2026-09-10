import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

/**
 * Registry KHUSUS untuk metrics aplikasi ini — bukan `register` global
 * bawaan `prom-client` (default export lama) supaya tidak ada resiko
 * metric "menempel" ke registry lain kalau di masa depan ada modul
 * lain yang juga memakai prom-client secara independen (mis. sebuah
 * dependency pihak ketiga). Satu registry, satu sumber kebenaran
 * untuk endpoint `/metrics`.
 */
export const metricsRegistry = new Registry();

/**
 * Metric proses bawaan Node.js (CPU, memory, heap, event loop delay,
 * uptime, file descriptor, dst) — prom-client yang mengumpulkan
 * secara otomatis lewat polling berkala, kita cukup mendaftarkan
 * registry tujuannya. Prefix `nodejs_` & `process_` mengikuti
 * konvensi resmi Prometheus Node.js client supaya dashboard Grafana
 * yang sudah umum dipakai orang lain (mis. official Node.js dashboard)
 * langsung kompatibel tanpa perlu di-rename manual.
 */
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Total request HTTP yang masuk, dipecah per method/route/status —
 * label `route` SENGAJA memakai path pattern (`/api/v1/events/:id`),
 * BUKAN `req.originalUrl` mentah (`/api/v1/events/3f2a...-uuid`).
 * Kalau memakai URL mentah, cardinality metric akan meledak (satu
 * time series baru untuk SETIAP id unik yang pernah diakses) — ini
 * kesalahan paling umum saat instrumentasi Express dengan Prometheus.
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total jumlah HTTP request yang diterima',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

/**
 * Durasi request dalam detik (satuan standar Prometheus, bukan ms) —
 * histogram, bukan gauge/summary, supaya bisa dihitung ulang sebagai
 * percentile (p50/p95/p99) di sisi query time lewat `histogram_quantile()`
 * di Grafana, dan tetap bisa diagregasi lintas-instance (beda dengan
 * summary yang percentile-nya sudah dihitung di sisi klien dan tidak
 * bisa digabung).
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Distribusi durasi HTTP request dalam detik',
  labelNames: ['method', 'route', 'status_code'] as const,
  // Bucket dipilih untuk API HTTP tipikal: dari request sangat cepat
  // (5ms) sampai request lambat yang layak diselidiki (10s). Sesuaikan
  // kalau profil latency aplikasi ternyata jauh berbeda.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Jumlah request yang SEDANG diproses saat ini (belum selesai) — gauge
 * karena nilainya naik-turun (bukan monotonic seperti Counter). Berguna
 * untuk mendeteksi request yang menggantung/lambat sebelum berujung ke
 * `httpRequestDurationSeconds` (yang baru tercatat setelah request
 * SELESAI).
 */
export const httpRequestsActive = new Gauge({
  name: 'http_requests_active',
  help: 'Jumlah HTTP request yang sedang diproses saat ini',
  labelNames: ['method'] as const,
  registers: [metricsRegistry],
});

/**
 * Total response dengan status error (4xx & 5xx) — metric TURUNAN dari
 * `httpRequestsTotal` (bisa dihitung ulang lewat PromQL dari label
 * `status_code`), tapi disediakan sebagai Counter terpisah karena
 * "error rate" adalah query yang SANGAT sering dipakai untuk alerting
 * — lebih murah & lebih jelas dibaca langsung dari satu metric
 * daripada menulis regex label di setiap alert rule.
 */
export const httpErrorsTotal = new Counter({
  name: 'http_errors_total',
  help: 'Total jumlah HTTP response dengan status code error (4xx/5xx)',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});
