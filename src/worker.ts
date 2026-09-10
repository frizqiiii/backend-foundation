// Phase 13 — sama alasannya seperti `server.ts`: proses worker adalah
// proses Node TERPISAH, jadi butuh `startTracing()` sendiri, sebagai
// import paling pertama juga (sebelum BullMQ/ioredis sempat di-require
// oleh import lain di bawah).
import { startTracing } from './shared/observability/tracing';
startTracing();

import { env } from './shared/config/env';
import { initSentry, Sentry } from './shared/config/sentry';

// Sentry diinisialisasi di sini juga — proses worker adalah proses
// Node terpisah dari API server (`server.ts`), jadi butuh inisialisasi
// sendiri supaya error di worker ikut termonitor.
initSentry();

import { logger } from './shared/logger';
import { emailWorker } from './workers/email.worker';
import { notificationWorker } from './workers/notification.worker';
import { webhookDeliveryWorker } from './workers/webhook.worker';
import { exportWorker, exportWorkerPrisma } from './workers/export.worker';
import { startScheduler } from './shared/scheduler';
import { sendWorkerHeartbeat } from './shared/queue/queue.metrics';
import { createGuardedShutdown } from './shared/reliability/shutdown-guard';

/**
 * Scheduler (job cleanup token kedaluwarsa, database maintenance)
 * DISENGAJA tidak bergantung pada `REDIS_URL` seperti `emailWorker`/
 * `notificationWorker` di bawah — jadwalnya murni operasi database
 * (PostgreSQL), tidak lewat BullMQ/Redis sama sekali. Jadi tetap
 * didaftarkan meski Redis tidak dikonfigurasi, SEBELUM early-return
 * di bawah yang khusus mengecek worker BullMQ.
 */
startScheduler();

/**
 * Entry point PROSES WORKER — dijalankan TERPISAH dari API server
 * (`node dist/server.js` vs `node dist/worker.js`), sesuai praktik
 * message queue yang benar: worker tidak boleh berbagi proses dengan
 * server yang melayani HTTP request, supaya beban pemrosesan job
 * (pengiriman email, dst) tidak pernah memperlambat response time API.
 *
 * Kalau `REDIS_URL` tidak dikonfigurasi, kedua worker BullMQ di atas
 * bernilai `null` — TAPI proses ini TIDAK BOLEH langsung keluar lagi
 * seperti sebelumnya (`process.exit(0)`), karena scheduler yang baru
 * didaftarkan di atas murni bergantung pada database, bukan Redis, dan
 * tetap harus terus berjalan menunggu jadwal cron berikutnya.
 */
logger.info(
  `Worker process berjalan [${env.NODE_ENV}] — menunggu job dari antrian & jadwal cron...`
);

if (!emailWorker && !notificationWorker && !webhookDeliveryWorker && !exportWorker) {
  logger.warn(
    'REDIS_URL tidak dikonfigurasi — worker BullMQ (email/notification/webhook-delivery/export) tidak aktif, tapi scheduler tetap berjalan.'
  );
}

/**
 * Heartbeat periodik (Phase 10 upgrade — Worker Health) — interval
 * 10 detik, SEPERTIGA dari ambang "stale" (30 detik) di
 * `queue.metrics.ts`, memberi margin 2 heartbeat yang boleh terlewat
 * (mis. GC pause sesaat) sebelum worker dianggap mati oleh metric.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;
const heartbeatIntervals: ReturnType<typeof setInterval>[] = [];

if (emailWorker) {
  heartbeatIntervals.push(
    setInterval(() => void sendWorkerHeartbeat('email'), HEARTBEAT_INTERVAL_MS)
  );
}
if (notificationWorker) {
  heartbeatIntervals.push(
    setInterval(() => void sendWorkerHeartbeat('notification'), HEARTBEAT_INTERVAL_MS)
  );
}
if (webhookDeliveryWorker) {
  heartbeatIntervals.push(
    setInterval(() => void sendWorkerHeartbeat('webhook-delivery'), HEARTBEAT_INTERVAL_MS)
  );
}
if (exportWorker) {
  heartbeatIntervals.push(
    setInterval(() => void sendWorkerHeartbeat('export'), HEARTBEAT_INTERVAL_MS)
  );
}

/**
 * Force-exit timeout (P0 hardening).
 *
 * SEBELUMNYA `worker.close()` BullMQ menunggu job yang sedang
 * berjalan selesai TANPA batas waktu — kalau satu job hang (mis.
 * menunggu dependency eksternal yang tidak pernah respon), proses
 * worker tidak akan pernah exit sendiri, memaksa orchestrator
 * mengirim SIGKILL yang tidak sempat membersihkan apa pun. Pola
 * force-exit ini SENGAJA disamakan dengan `server.ts` (pakai
 * `SHUTDOWN_TIMEOUT_MS` yang sama) supaya perilaku kedua proses
 * konsisten dan predictable. Guard anti-double-shutdown (kalau
 * `SIGTERM` beruntun, atau bersamaan dengan `uncaughtException`
 * di bawah) diekstrak ke `createGuardedShutdown` — lihat komentarnya
 * di `shared/reliability/shutdown-guard.ts` untuk alasan lengkapnya.
 */
const shutdown = createGuardedShutdown(shutdownImpl, (signal) =>
  logger.warn(`Menerima ${signal} saat shutdown sudah berjalan — diabaikan.`)
);

async function shutdownImpl(signal: string): Promise<void> {
  logger.info(`Menerima ${signal}, menutup worker dengan aman...`);
  heartbeatIntervals.forEach(clearInterval);

  const forceExitTimer = setTimeout(() => {
    logger.error(
      `Graceful shutdown worker melebihi batas waktu ${env.SHUTDOWN_TIMEOUT_MS}ms — keluar paksa`
    );
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    await Promise.all([
      emailWorker?.close(),
      notificationWorker?.close(),
      webhookDeliveryWorker?.close(),
      exportWorker?.close(),
      exportWorkerPrisma.$disconnect(),
    ]);
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Gagal shutdown worker dengan bersih');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * `uncaughtException` / `unhandledRejection` (P0 hardening) — alasan
 * sama persis dengan `server.ts` (lihat komentar lengkap di sana):
 * tanpa handler ini, exception yang lolos dari try/catch di worker
 * (mis. error di job processor yang tidak ter-await dengan benar)
 * akan membunuh proses worker TANPA menutup koneksi BullMQ/Redis/
 * Prisma dengan bersih dan tanpa dilaporkan ke Sentry.
 */
process.on('uncaughtException', (error) => {
  logger.fatal(
    { err: error },
    'uncaughtException — worker akan dihentikan dengan graceful shutdown'
  );
  Sentry.captureException(error);
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.fatal(
    { err: reason },
    'unhandledRejection — worker akan dihentikan dengan graceful shutdown'
  );
  Sentry.captureException(reason);
  void shutdown('unhandledRejection');
});
