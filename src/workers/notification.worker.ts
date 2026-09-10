import { Worker } from 'bullmq';
import { queueConnection } from '../shared/queue/connection';
import { processNotificationJob } from '../shared/queue/notification.queue';
import type { NotificationJobData } from '../shared/queue/notification.queue';
import { moveToDeadLetter } from '../shared/queue/dead-letter.queue';
import { logger } from '../shared/logger';
import { env } from '../shared/config/env';
import { bullMQTelemetry } from '../shared/observability/bullmq-telemetry';
import { observeQueueProcessingTime } from '../shared/queue/queue.metrics';

/**
 * Phase 14 — `concurrency` dikonfigurasi seperti `email.worker.ts`,
 * TANPA `limiter` — notifikasi (lihat `notification.queue.ts`) tidak
 * dikirim ke provider pihak ketiga yang rate-limit-nya perlu dijaga
 * seperti SMTP/SES, jadi lapisan kontrol kedua itu tidak relevan di
 * sini.
 */
export const notificationWorker = queueConnection
  ? new Worker<NotificationJobData>(
      'notification',
      async (job) => {
        await observeQueueProcessingTime('notification', () => processNotificationJob(job.data));
      },
      {
        connection: queueConnection,
        concurrency: env.NOTIFICATION_QUEUE_CONCURRENCY,
        telemetry: bullMQTelemetry ?? undefined,
      }
    )
  : null;

if (notificationWorker) {
  notificationWorker.on('completed', (job) => {
    logger.info(`Notification job ${job.id} selesai diproses`);
  });
  notificationWorker.on('failed', (job, err) => {
    logger.error({ err }, `Notification job ${job?.id} gagal diproses`);

    // Lihat catatan Dead Letter Queue di `email.worker.ts` — pola sama.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void moveToDeadLetter({
        queue: 'notification',
        jobName: job.name,
        data: job.data,
        failedReason: err.message,
        attemptsMade: job.attemptsMade,
      });
    }
  });
}
