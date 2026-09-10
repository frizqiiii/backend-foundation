import { Worker } from 'bullmq';
import { queueConnection } from '../shared/queue/connection';
import { processEmailJob } from '../shared/queue/email.queue';
import type { EmailJobData } from '../shared/queue/email.queue';
import { moveToDeadLetter } from '../shared/queue/dead-letter.queue';
import { logger } from '../shared/logger';
import { env } from '../shared/config/env';
import { bullMQTelemetry } from '../shared/observability/bullmq-telemetry';
import { observeQueueProcessingTime } from '../shared/queue/queue.metrics';

/**
 * Worker untuk queue `email` — proses NYATA berjalan di PROCESS
 * TERPISAH dari API server (lihat `src/worker.ts`, dijalankan lewat
 * `npm run worker`), bukan di dalam request/response cycle HTTP.
 * `null` kalau Redis tidak dikonfigurasi (lihat `connection.ts`) —
 * dalam kondisi itu, job tidak pernah masuk antrian sama sekali sejak
 * awal (`enqueueEmailJob` sudah fallback sinkron), jadi worker ini
 * memang tidak perlu/tidak bisa berjalan.
 *
 * Phase 14 (Enterprise Scalability) — DUA lapisan kontrol throughput,
 * beda tujuan:
 * - `concurrency`: berapa job boleh diproses BERSAMAAN di worker
 *   PROSES INI. Menaikkannya meningkatkan throughput per-proses.
 * - `limiter`: berapa job boleh MULAI diproses per satuan waktu,
 *   dihitung BULLMQ SENDIRI lintas SEMUA worker yang membaca queue
 *   `email` yang sama (termasuk kalau proses worker di-scale ke
 *   banyak instance) — inilah yang benar-benar melindungi provider
 *   SMTP/SES pihak ketiga dari dibanjiri request, karena batasnya
 *   berlaku GLOBAL per queue, bukan per proses.
 */
export const emailWorker = queueConnection
  ? new Worker<EmailJobData>(
      'email',
      async (job) => {
        await observeQueueProcessingTime('email', () => processEmailJob(job.data));
      },
      {
        connection: queueConnection,
        concurrency: env.EMAIL_QUEUE_CONCURRENCY,
        limiter: {
          max: env.EMAIL_QUEUE_RATE_LIMIT_MAX,
          duration: env.EMAIL_QUEUE_RATE_LIMIT_DURATION_MS,
        },
        telemetry: bullMQTelemetry ?? undefined,
      }
    )
  : null;

if (emailWorker) {
  emailWorker.on('completed', (job) => {
    logger.info(`Email job ${job.id} (${job.name}) selesai diproses`);
  });
  emailWorker.on('failed', (job, err) => {
    logger.error({ err }, `Email job ${job?.id} (${job?.name}) gagal diproses`);

    // Dead Letter Queue (Phase 10 upgrade) — HANYA dipindahkan ketika
    // job benar-benar kehabisan seluruh percobaan retry
    // (`attemptsMade >= attempts` dari `defaultJobOptions` di
    // `email.queue.ts`), bukan setiap kegagalan individual (yang
    // masih akan di-retry otomatis oleh BullMQ sendiri).
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void moveToDeadLetter({
        queue: 'email',
        jobName: job.name,
        data: job.data,
        failedReason: err.message,
        attemptsMade: job.attemptsMade,
      });
    }
  });
}
