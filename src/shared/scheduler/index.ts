import cron from 'node-cron';
import { logger } from '../logger';
import { runJobWithRetry } from './job-runner';
import type { ScheduledJobDefinition } from './scheduler.types';
import { cleanupExpiredRefreshTokensJob } from './jobs/cleanup-expired-refresh-tokens.job';
import { cleanupExpiredBlacklistedTokensJob } from './jobs/cleanup-expired-blacklisted-tokens.job';
import { cleanupExpiredAuthTokensJob } from './jobs/cleanup-expired-auth-tokens.job';
import { databaseMaintenanceJob } from './jobs/database-maintenance.job';

/**
 * Seluruh job terdaftar di satu tempat — menambah job baru cukup
 * membuat file `jobs/<nama>.job.ts` baru (ikuti kontrak
 * `ScheduledJobDefinition`) dan mendaftarkannya di array ini.
 */
const registeredJobs: ScheduledJobDefinition[] = [
  cleanupExpiredRefreshTokensJob,
  cleanupExpiredBlacklistedTokensJob,
  cleanupExpiredAuthTokensJob,
  databaseMaintenanceJob,
];

/**
 * Mendaftarkan & menjalankan seluruh scheduled job lewat `node-cron`.
 *
 * SENGAJA dipanggil dari `worker.ts`, BUKAN `server.ts` — scheduled
 * job secara konsep adalah tanggung jawab proses background, terpisah
 * dari proses yang melayani HTTP request.
 *
 * Phase 14 (Enterprise Scalability) — proses worker TIDAK LAGI wajib
 * satu instance untuk scheduler ini aman dijalankan: setiap job
 * dibungkus distributed lock (lihat `job-runner.ts`/
 * `shared/concurrency/distributed-lock.ts`) yang memastikan hanya SATU
 * instance yang benar-benar mengeksekusi job yang sama di jendela
 * waktu cron yang sama, instance lain otomatis melewatinya. Ini
 * MENGGANTIKAN batasan lama ("worker harus single-instance") — TAPI
 * proteksi ini bergantung pada `REDIS_URL` terkonfigurasi; tanpa
 * Redis, lock fail-open (lihat komentar `acquireLock`) dan batasan
 * lama itu kembali berlaku (worker harus tetap satu instance).
 *
 * `timezone: 'UTC'` disamakan eksplisit dengan `expiresAt`/`createdAt`
 * di database (`DateTime` Prisma disimpan UTC secara default) — tanpa
 * ini, jadwal cron mengikuti timezone server yang menjalankan proses,
 * yang bisa berbeda-beda tergantung environment (lokal vs container
 * production) dan membuat waktu eksekusi job sulit diprediksi.
 */
export function startScheduler(): void {
  for (const job of registeredJobs) {
    if (!cron.validate(job.cronExpression)) {
      logger.error(
        { job: job.name, cronExpression: job.cronExpression },
        `Scheduler: cron expression tidak valid untuk job "${job.name}" — job ini TIDAK didaftarkan`
      );
      continue;
    }

    cron.schedule(job.cronExpression, () => void runJobWithRetry(job), { timezone: 'UTC' });
    logger.info(
      { job: job.name, cronExpression: job.cronExpression },
      `Scheduler: job "${job.name}" terdaftar`
    );
  }

  logger.info(`Scheduler: ${registeredJobs.length} job aktif`);
}
