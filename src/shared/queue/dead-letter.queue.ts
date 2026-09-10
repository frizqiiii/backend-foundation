import { Queue } from 'bullmq';
import { queueConnection } from './connection';
import { logger } from '../logger';
import { bullMQTelemetry } from '../observability/bullmq-telemetry';

/**
 * Antrian "kuburan" untuk job yang GAGAL PERMANEN — sudah menghabiskan
 * seluruh percobaan retry (`attemptsMade >= opts.attempts`) di queue
 * aslinya. BullMQ TIDAK punya konsep DLQ bawaan (beda dari mis. AWS
 * SQS) — job gagal by default hanya tertahan di state `failed` pada
 * queue yang sama. Memisahkannya ke queue TERSENDIRI (bukan sekadar
 * mengandalkan state `failed`) membuat operator bisa memonitor
 * "seberapa banyak yang benar-benar menyerah" secara terpisah dari
 * "sedang retry" tanpa query rumit, dan job di sini bisa di-inspect/
 * di-retry manual lewat Bull Board tanpa bercampur dengan antrian
 * produksi yang aktif.
 *
 * Payload yang disimpan menyertakan `queue`/`jobName` asal + error
 * terakhir — cukup konteks untuk investigasi tanpa perlu melihat log
 * aplikasi terpisah.
 */
export interface DeadLetterJobData {
  queue: string;
  jobName: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
}

export const deadLetterQueue = queueConnection
  ? new Queue<DeadLetterJobData>('dead-letter', {
      connection: queueConnection,
      telemetry: bullMQTelemetry ?? undefined,
    })
  : null;

/**
 * Dipanggil dari handler event `'failed'` tiap Worker (lihat
 * `email.worker.ts`/`notification.worker.ts`) — HANYA saat job benar-
 * benar kehabisan seluruh percobaan (bukan setiap kegagalan individual,
 * yang masih akan di-retry otomatis oleh BullMQ sendiri berkat
 * `defaultJobOptions.attempts` di queue asal).
 *
 * SENGAJA dibungkus try/catch dan tidak pernah melempar ulang — gagal
 * mencatat ke DLQ tidak boleh sampai mengganggu proses worker utama;
 * cukup di-log sebagai warning, pola yang sama seperti `AuditService`.
 */
export async function moveToDeadLetter(data: DeadLetterJobData): Promise<void> {
  if (!deadLetterQueue) {
    return;
  }

  try {
    await deadLetterQueue.add('dead-letter', data);
  } catch (error) {
    logger.warn(
      { err: error, originalQueue: data.queue, jobName: data.jobName },
      'moveToDeadLetter: gagal mencatat job ke dead-letter queue'
    );
  }
}
