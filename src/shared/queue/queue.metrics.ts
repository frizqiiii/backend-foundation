import { Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from '../../modules/monitoring/metrics/metrics.registry';
import { emailQueue } from './email.queue';
import { notificationQueue } from './notification.queue';
import { deadLetterQueue } from './dead-letter.queue';
import { webhookDeliveryQueue } from './webhook-delivery.queue';
import { exportQueue } from './export.queue';
import { queueConnection } from './connection';
import { logger } from '../logger';
import type { Queue } from 'bullmq';

/**
 * Statistik kedalaman antrian (Phase 10 upgrade — "Queue Statistics").
 * Didaftarkan ke `metricsRegistry` YANG SAMA dengan metric HTTP di
 * `metrics.registry.ts` — sengaja SATU endpoint `/metrics` untuk
 * semuanya (bukan endpoint terpisah), supaya satu Prometheus scrape
 * target + satu dashboard Grafana sudah cukup untuk observability
 * aplikasi maupun antrian.
 *
 * Gauge dengan `collect()` ASYNC (didukung prom-client v15+) —
 * `getJobCounts()` BullMQ dipanggil HANYA saat Prometheus benar-benar
 * scrape (`GET /metrics`), bukan polling terus-menerus di background.
 * Ini menghindari beban tambahan ke Redis kalau tidak ada yang
 * benar-benar membaca metric-nya.
 */
export const queueJobsGauge = new Gauge({
  name: 'queue_jobs_total',
  help: 'Jumlah job BullMQ per queue dan per status (waiting/active/delayed/completed/failed)',
  labelNames: ['queue', 'status'] as const,
  registers: [metricsRegistry],
  async collect() {
    const queues: ReadonlyArray<[string, Queue | null]> = [
      ['email', emailQueue],
      ['notification', notificationQueue],
      ['dead-letter', deadLetterQueue],
      // Phase 19 — gap yang sama seperti `dashboard.ts`: kedua queue
      // ini sebelumnya tidak ikut ter-scrape ke Prometheus sama
      // sekali.
      ['webhook-delivery', webhookDeliveryQueue],
      ['export', exportQueue],
    ];

    await Promise.all(
      queues.map(async ([name, queue]) => {
        if (!queue) {
          return;
        }

        try {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'completed',
            'failed'
          );
          for (const [status, count] of Object.entries(counts)) {
            this.set({ queue: name, status }, count);
          }
        } catch (error) {
          // Redis lambat/down SAAT SCRAPE tidak boleh membuat seluruh
          // endpoint `/metrics` gagal (metric HTTP lain yang tidak
          // terkait queue tetap harus terkirim) — cukup di-log,
          // gauge queue ini saja yang tertinggal dengan nilai lama.
          logger.warn({ err: error, queue: name }, 'queueJobsGauge: gagal mengambil job counts');
        }
      })
    );
  },
});

/**
 * Worker Health (Phase 10 upgrade) — `1` kalau worker queue tersebut
 * masih mengirim heartbeat baru-baru ini, `0` kalau tidak (mati/hang).
 *
 * Dibaca lewat Redis (heartbeat key `worker:heartbeat:<queue>`, di-set
 * berkala oleh `src/worker.ts`, PROSES TERPISAH dari API server yang
 * melayani `/metrics`) — BUKAN in-memory di proses ini, karena API
 * server dan worker adalah dua proses Node berbeda (lihat komentar di
 * `src/worker.ts`: keduanya SENGAJA dipisah supaya beban job tidak
 * memperlambat response HTTP). In-memory gauge yang di-`set()` di
 * proses worker tidak akan pernah terlihat oleh registry di proses API
 * server; Redis adalah satu-satunya "papan tulis" bersama keduanya.
 */
const WORKER_HEARTBEAT_STALE_MS = 30_000; // > 3x interval heartbeat (lihat `src/worker.ts`)

export const workerHealthGauge = new Gauge({
  name: 'queue_worker_up',
  help: 'Status worker BullMQ berdasarkan heartbeat Redis: 1 = berjalan, 0 = berhenti/tidak terdeteksi',
  labelNames: ['queue'] as const,
  registers: [metricsRegistry],
  async collect() {
    if (!queueConnection) {
      return;
    }
    // Ditangkap ke variabel lokal — TypeScript TIDAK menyempitkan
    // (narrow) binding `const` yang diimpor dari modul lain di dalam
    // closure async (`workerNames.map(async ...)` di bawah), walau
    // sudah dicek `!queueConnection` persis di atas. Menangkapnya ke
    // `connection` lokal di scope `collect()` ini membuat TypeScript
    // yakin nilainya tidak berubah lagi sebelum dipakai di closure.
    const connection = queueConnection;

    // Phase 19 — 'webhook-delivery' dan 'export' ditambahkan (gap
    // yang sama seperti `queueJobsGauge`/`dashboard.ts` di atas):
    // `src/worker.ts` SUDAH mengirim heartbeat untuk keduanya sejak
    // masing-masing worker dibuat, tapi gauge ini sebelumnya tidak
    // ikut membacanya balik.
    const workerNames = ['email', 'notification', 'webhook-delivery', 'export'];

    await Promise.all(
      workerNames.map(async (name) => {
        try {
          const lastHeartbeat = await connection.get(`worker:heartbeat:${name}`);
          const isAlive =
            lastHeartbeat !== null &&
            Date.now() - Number(lastHeartbeat) < WORKER_HEARTBEAT_STALE_MS;
          this.set({ queue: name }, isAlive ? 1 : 0);
        } catch (error) {
          logger.warn({ err: error, queue: name }, 'workerHealthGauge: gagal membaca heartbeat');
        }
      })
    );
  },
});

/**
 * Dipanggil dari `src/worker.ts` secara berkala (`setInterval`) —
 * menulis timestamp saat ini ke Redis sebagai bukti "worker ini masih
 * hidup dan responsif", dibaca kembali oleh `workerHealthGauge` di
 * atas (dari proses API server manapun) saat `/metrics` di-scrape.
 */
export async function sendWorkerHeartbeat(queueName: string): Promise<void> {
  if (!queueConnection) {
    return;
  }

  try {
    await queueConnection.set(`worker:heartbeat:${queueName}`, Date.now().toString());
  } catch (error) {
    logger.warn({ err: error, queue: queueName }, 'sendWorkerHeartbeat: gagal menulis heartbeat');
  }
}

/**
 * Durasi pemrosesan SATU job BullMQ (Phase 20 upgrade — "Queue
 * Management Enterprise"), dari saat processor mulai dipanggil sampai
 * selesai — sukses MAUPUN gagal (label `status`, sama polanya dengan
 * `queueJobsGauge` di atas). Melengkapi `queue_jobs_total` (KEDALAMAN
 * antrian saat ini) dan `queue_worker_up` (HIDUP/MATI-nya worker) —
 * ketiganya bersama-sama menjawab tiga pertanyaan operasional berbeda:
 * "seberapa penuh", "apakah worker jalan", dan "seberapa cepat job
 * diproses" (mis. untuk mendeteksi job yang mulai melambat SEBELUM
 * antrian benar-benar menumpuk).
 *
 * Histogram (bukan Gauge seperti dua metric lain) — durasi butuh
 * distribusi (p50/p95/p99 lewat `histogram_quantile` di Prometheus),
 * bukan cuma angka terakhir; Gauge hanya bisa menyimpan SATU nilai
 * terkini per label, yang akan tertimpa job berikutnya sebelum
 * sempat di-scrape.
 */
export const queueProcessingTimeHistogram = new Histogram({
  name: 'queue_processing_time',
  help: 'Durasi pemrosesan satu job BullMQ dalam detik, diukur dari processor mulai dipanggil sampai selesai (label status: completed/failed)',
  labelNames: ['queue', 'status'] as const,
  // Rentang detik jauh lebih lebar dari `httpRequestDurationSeconds`
  // (yang mentok di 10 detik) — job BullMQ di aplikasi ini (export
  // ribuan baris, pengiriman email/webhook dengan retry) wajar makan
  // waktu puluhan detik sampai beberapa menit, beda karakteristik dari
  // request HTTP yang idealnya sub-detik.
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegistry],
});

/**
 * Pembungkus generic untuk dipakai LANGSUNG di processor tiap worker
 * (`email.worker.ts`/`notification.worker.ts`/`webhook.worker.ts`/
 * `export.worker.ts`) — SATU implementasi timing dipakai bersama
 * keempatnya, bukan diduplikasi 4 kali. Error dari `fn` SELALU
 * dilempar ulang APA ADANYA (bukan ditelan) — instrumentasi metrik
 * tidak boleh mengubah perilaku retry/dead-letter BullMQ yang sudah
 * ada, hanya mengamati dari luar.
 */
export async function observeQueueProcessingTime<T>(
  queueName: string,
  fn: () => Promise<T>
): Promise<T> {
  const endTimer = queueProcessingTimeHistogram.startTimer({ queue: queueName });
  try {
    const result = await fn();
    endTimer({ status: 'completed' });
    return result;
  } catch (error) {
    endTimer({ status: 'failed' });
    throw error;
  }
}
