import { Worker } from 'bullmq';
import { queueConnection } from '../shared/queue/connection';
import { processWebhookDeliveryJob } from '../shared/queue/webhook-delivery.queue';
import type { WebhookDeliveryJobData } from '../shared/queue/webhook-delivery.queue';
import { moveToDeadLetter } from '../shared/queue/dead-letter.queue';
import { logger } from '../shared/logger';
import { env } from '../shared/config/env';
import { bullMQTelemetry } from '../shared/observability/bullmq-telemetry';
import { observeQueueProcessingTime } from '../shared/queue/queue.metrics';

/**
 * Worker untuk queue `webhook-delivery` — pola SAMA PERSIS dengan
 * `email.worker.ts` (lihat komentar lengkap di sana). `concurrency`
 * memakai `EMAIL_QUEUE_CONCURRENCY` (BUKAN variabel terpisah) —
 * SENGAJA berbagi env var yang sama dengan email, karena keduanya
 * sama-sama "kirim payload ke sistem eksternal", karakteristik
 * beban kerjanya serupa (I/O-bound, menunggu response HTTP), dan
 * menambah SATU env var lagi hanya untuk nilai yang biasanya akan
 * disamakan dengan email tidak sepadan dengan kompleksitasnya. Tidak
 * ada `limiter` (rate limit) di sini — beda dari email/SMTP, TIDAK
 * ada satu "provider pihak ketiga" tunggal yang perlu dilindungi dari
 * dibanjiri request; setiap endpoint webhook adalah server BERBEDA
 * milik user berbeda-beda.
 */
export const webhookDeliveryWorker = queueConnection
  ? new Worker<WebhookDeliveryJobData>(
      'webhook-delivery',
      async (job) => {
        await observeQueueProcessingTime('webhook-delivery', () =>
          processWebhookDeliveryJob(job.data)
        );
      },
      {
        connection: queueConnection,
        concurrency: env.EMAIL_QUEUE_CONCURRENCY,
        telemetry: bullMQTelemetry ?? undefined,
      }
    )
  : null;

if (webhookDeliveryWorker) {
  webhookDeliveryWorker.on('completed', (job) => {
    logger.info(`Webhook delivery job ${job.id} (${job.name}) selesai diproses`);
  });
  webhookDeliveryWorker.on('failed', (job, err) => {
    logger.error({ err }, `Webhook delivery job ${job?.id} (${job?.name}) gagal diproses`);

    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void moveToDeadLetter({
        queue: 'webhook-delivery',
        jobName: job.name,
        data: job.data,
        failedReason: err.message,
        attemptsMade: job.attemptsMade,
      });
    }
  });
}
