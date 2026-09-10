import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { queueConnection } from '../shared/queue/connection';
import type { ExportJobData } from '../shared/queue/export.queue';
import { moveToDeadLetter } from '../shared/queue/dead-letter.queue';
import { logger } from '../shared/logger';
import { env } from '../shared/config/env';
import { bullMQTelemetry } from '../shared/observability/bullmq-telemetry';
import { ExportRepository } from '../modules/exports/export.repository';
import { ExportService } from '../modules/exports/export.service';
import { UserRepository } from '../modules/users/user.repository';
import { AuditRepository } from '../modules/audit/audit.repository';
import { DashboardRepository } from '../modules/dashboard/dashboard.repository';
import { DashboardService } from '../modules/dashboard/dashboard.service';
import { AnalyticsRepository } from '../modules/analytics/analytics.repository';
import { AnalyticsService } from '../modules/analytics/analytics.service';
import { ReportingService } from '../modules/reporting/reporting.service';
import { observeQueueProcessingTime } from '../shared/queue/queue.metrics';

/**
 * Worker untuk queue `export` — SAMA pola dengan `email.worker.ts`,
 * dengan SATU perbedaan: proses ini butuh `PrismaClient` SENDIRI
 * (BUKAN mengimpor `shared/config/database`'s singleton) karena
 * `src/worker.ts` (proses worker) dan `src/server.ts` (proses API)
 * adalah DUA PROSES NODE TERPISAH — masing-masing butuh connection
 * pool Prisma sendiri-sendiri, tidak bisa berbagi instance lintas
 * proses OS. Provider email/webhook lain di worker ini TIDAK butuh
 * ini karena logic-nya murni (tidak menyentuh database), export SATU-
 * SATUNYA worker yang butuh query Prisma langsung (lihat
 * `ExportService`).
 */
const prisma = new PrismaClient();
export { prisma as exportWorkerPrisma };
const dashboardRepository = new DashboardRepository(prisma);
const analyticsRepository = new AnalyticsRepository(prisma);
const exportService = new ExportService(
  new ExportRepository(prisma),
  new UserRepository(prisma),
  new AuditRepository(prisma),
  new DashboardService(dashboardRepository),
  new ReportingService(dashboardRepository, analyticsRepository),
  new AnalyticsService(analyticsRepository)
);

export const exportWorker = queueConnection
  ? new Worker<ExportJobData>(
      'export',
      async (job) => {
        await observeQueueProcessingTime('export', () => exportService.processExportJob(job.data));
      },
      {
        connection: queueConnection,
        concurrency: env.EXPORT_QUEUE_CONCURRENCY,
        telemetry: bullMQTelemetry ?? undefined,
        // P4 (Queue & Reliability) — SEBELUMNYA memakai default BullMQ
        // (30 detik), sama seperti email/notification/webhook. Worker
        // ini BEDA KARAKTERISTIK dari ketiganya: satu job di sini bisa
        // melakukan query sampai `EXPORT_MAX_ROWS` (5000) baris, LALU
        // generate file CSV/XLSX/PDF, LALU upload ke Object Storage
        // pihak ketiga — tiga tahap I/O berurutan, bukan satu panggilan
        // HTTP tunggal seperti email/notification/webhook. BullMQ
        // sendiri sudah otomatis memperpanjang lock (`lockRenewTime`,
        // separuh dari `lockDuration`) selama proses worker masih hidup
        // dan event loop tidak diblokir — tapi kalau Object Storage
        // sedang lambat (mis. beban tinggi), 30 detik default cukup
        // mepet untuk tiga tahap sekaligus. Dinaikkan ke 2 menit sebagai
        // margin aman; TIDAK mengubah `attempts`/`backoff` (masih dari
        // `defaultJobOptions` di `export.queue.ts`) — ini murni soal
        // berapa lama SATU percobaan dianggap masih berjalan wajar
        // sebelum BullMQ menganggapnya "stalled" (mis. worker process
        // crash di tengah jalan) dan menjadwalkannya ulang ke worker
        // lain.
        lockDuration: 120_000,
      }
    )
  : null;

if (exportWorker) {
  exportWorker.on('completed', (job) => {
    logger.info(`Export job ${job.id} (exportJobId=${job.data.exportJobId}) selesai diproses`);
  });
  exportWorker.on('failed', (job, err) => {
    logger.error(
      { err },
      `Export job ${job?.id} (exportJobId=${job?.data.exportJobId}) gagal diproses`
    );

    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void moveToDeadLetter({
        queue: 'export',
        jobName: job.name,
        data: job.data,
        failedReason: err.message,
        attemptsMade: job.attemptsMade,
      });
    }
  });
}
