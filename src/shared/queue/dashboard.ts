import type { Application } from 'express';
import basicAuth from 'express-basic-auth';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { emailQueue } from './email.queue';
import { notificationQueue } from './notification.queue';
import { deadLetterQueue } from './dead-letter.queue';
import { webhookDeliveryQueue } from './webhook-delivery.queue';
import { exportQueue } from './export.queue';
import { env } from '../config/env';
import { logger } from '../logger';

/**
 * Bull Board — UI visual untuk memonitor job BullMQ (waiting/active/
 * delayed/completed/failed per job, bukan cuma angka agregat seperti
 * `queue_jobs_total` di Prometheus), plus retry/hapus job manual
 * (mis. untuk job yang tersangkut di `dead-letter` — lihat
 * `dead-letter.queue.ts`).
 *
 * Dipasang KONDISIONAL: hanya kalau KETIGA syarat terpenuhi —
 * `queueConnection`/queue aktif (Redis dikonfigurasi) DAN
 * `QUEUE_DASHBOARD_USER`+`QUEUE_DASHBOARD_PASSWORD` keduanya diisi.
 * Lihat komentar env var di `shared/config/env.ts` untuk alasan
 * keamanan di balik "default TIDAK terpasang", bukan "terpasang tanpa
 * proteksi".
 */
export function mountQueueDashboard(app: Application): void {
  const queues = [
    emailQueue,
    notificationQueue,
    deadLetterQueue,
    // Phase 19 — SEBELUMNYA HILANG dari daftar ini (ditemukan saat
    // audit): `webhookDeliveryQueue` dan `exportQueue` sudah lama
    // (webhook) atau baru (export) ada sebagai queue BullMQ
    // sungguhan, tapi tidak pernah ikut terdaftar ke Bull Board —
    // job-nya berjalan normal, hanya TIDAK TERLIHAT di dashboard.
    webhookDeliveryQueue,
    exportQueue,
  ].filter((queue): queue is NonNullable<typeof queue> => queue !== null);

  if (queues.length === 0) {
    logger.info('Bull Board dashboard tidak dipasang — REDIS_URL tidak dikonfigurasi.');
    return;
  }

  if (!env.QUEUE_DASHBOARD_USER || !env.QUEUE_DASHBOARD_PASSWORD) {
    logger.info(
      'Bull Board dashboard tidak dipasang — QUEUE_DASHBOARD_USER/QUEUE_DASHBOARD_PASSWORD belum dikonfigurasi.'
    );
    return;
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });

  app.use(
    '/admin/queues',
    basicAuth({
      users: { [env.QUEUE_DASHBOARD_USER]: env.QUEUE_DASHBOARD_PASSWORD },
      challenge: true,
    }),
    serverAdapter.getRouter()
  );

  logger.info('Bull Board dashboard terpasang di /admin/queues');
}
