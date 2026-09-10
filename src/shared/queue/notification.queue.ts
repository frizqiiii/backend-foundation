import { Queue } from 'bullmq';
import { queueConnection } from './connection';
import { logger } from '../logger';
import { bullMQTelemetry } from '../observability/bullmq-telemetry';

export interface NotificationJobData {
  userId: string;
  message: string;
}

/**
 * `defaultJobOptions` (Phase 10 upgrade) — attempts LEBIH SEDIKIT
 * (3, bukan 5 seperti `email.queue.ts`) dan `removeOnComplete: true`
 * (instan, bukan menyisakan riwayat) — konsisten dengan komentar
 * `enqueueNotificationJob` di bawah: notifikasi in-app SENGAJA boleh
 * "di-drop kalau menumpuk", volumenya jauh lebih tinggi dan nilai
 * per-job jauh lebih rendah daripada email verifikasi/reset password.
 */
export const notificationQueue = queueConnection
  ? new Queue<NotificationJobData>('notification', {
      connection: queueConnection,
      telemetry: bullMQTelemetry ?? undefined,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    })
  : null;

/**
 * Dipakai ketika ADMIN mengubah/menghapus resource milik user LAIN
 * (lihat `EventService.updateEvent`/`deleteEvent`) — pemilik resource
 * berhak tahu ada moderasi yang terjadi pada miliknya. Berbeda dari
 * `email.queue.ts`: ini murni notifikasi in-app/log, bukan email,
 * sengaja dipisah jadi antrian sendiri supaya volume/prioritas
 * masing-masing bisa diatur independen (mis. notifikasi boleh
 * di-drop kalau menumpuk, email verifikasi tidak boleh).
 */
export async function enqueueNotificationJob(data: NotificationJobData): Promise<void> {
  if (notificationQueue) {
    await notificationQueue.add('notify', data);
    return;
  }

  await processNotificationJob(data);
}

/**
 * Implementasi SAAT INI hanya mencatat ke log — sama seperti
 * `mailer.ts`, ini titik seam yang jelas untuk diganti nanti dengan
 * penyimpanan notifikasi sungguhan (tabel `Notification` + endpoint
 * `GET /notifications`) atau push notification, tanpa menyentuh
 * pemanggilnya sama sekali.
 */
export async function processNotificationJob(data: NotificationJobData): Promise<void> {
  logger.info({ userId: data.userId }, `[NOTIFIKASI] ${data.message}`);
}
