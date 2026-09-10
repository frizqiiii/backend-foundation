// Phase 13 — HARUS jadi import PALING PERTAMA di seluruh proses, lebih
// dulu dari `env`/Sentry/apa pun lain. Lihat komentar lengkap "KRITIS"
// di `shared/observability/tracing.ts` untuk alasan urutan ini.
import { startTracing } from './shared/observability/tracing';
startTracing();

import { env } from './shared/config/env';
import { initSentry } from './shared/config/sentry';

// Sentry HARUS diinisialisasi sebelum `createApp` di-import — supaya
// instrumentasi otomatisnya terpasang lebih dulu.
//
// CATATAN OVERLAP (Phase 13) — `@sentry/node` MEMBAWA OpenTelemetry-nya
// SENDIRI secara internal. Kalau `OTEL_ENABLED=true` DAN `SENTRY_DSN`
// diisi sekaligus, KEDUANYA akan mencoba meng-instrument modul yang
// sama (http, express, dst) secara independen — bukan error fatal,
// tapi berpotensi span dobel/membingungkan. Rekomendasi: pilih SATU
// jalur tracing per environment, jangan aktifkan berdampingan di
// production (lihat `docs/observability-guide.md`).
initSentry();

import { createApp } from './app';
import { logger } from './shared/logger';
import { prisma, prismaRead } from './shared/config/database';
import { redisClient } from './shared/config/redis';
import { queueConnection } from './shared/queue/connection';
import { setShuttingDown } from './modules/monitoring/health/health.controller';
import { Sentry } from './shared/config/sentry';
import { createGuardedShutdown } from './shared/reliability/shutdown-guard';

/**
 * Entry point aplikasi.
 * `env` di-import lebih dulu agar validasi environment variable
 * (fail-fast) berjalan sebelum apa pun lainnya diinisialisasi.
 */
const app = createApp();

const httpServer = app.listen(env.PORT, () => {
  logger.info(`🚀 Server berjalan di http://localhost:${env.PORT} [${env.NODE_ENV}]`);
});

/**
 * Graceful Shutdown (Phase 18 — Enterprise Reliability).
 *
 * SEBELUMNYA proses ini TIDAK PUNYA shutdown handler sama sekali —
 * SIGTERM (dikirim Kubernetes/PM2/Docker saat scale-down atau
 * deploy) langsung membunuh proses, memutus SELURUH request yang
 * sedang diproses di tengah jalan (client menerima connection reset,
 * bukan response), DAN meninggalkan koneksi database/Redis
 * tergantung sampai OS yang membersihkannya — beda jauh dari
 * `worker.ts` yang sudah punya `shutdown()` sejak awal.
 *
 * Urutan langkah SENGAJA, bukan asal:
 * 1. `setShuttingDown()` — `/ready` langsung 503 (lihat komentar
 *    lengkap di `health.controller.ts`), supaya load balancer
 *    berhenti mengirim request BARU secepat mungkin.
 * 2. `httpServer.close()` — berhenti MENERIMA koneksi baru, TAPI
 *    request yang SUDAH masuk tetap diproses sampai selesai (ini
 *    perilaku bawaan Node `http.Server.close()`).
 * 3. Tunggu `httpServer.close()` selesai (semua request beres) ATAU
 *    `SHUTDOWN_TIMEOUT_MS` habis (fallback paksa) — mana yang lebih
 *    dulu tercapai. Tanpa fallback ini, SATU request yang macet
 *    (mis. menunggu dependency yang hang) bisa membuat proses tidak
 *    pernah keluar sama sekali, memaksa orchestrator mengirim
 *    SIGKILL yang jauh lebih kasar (tidak ada kesempatan cleanup
 *    apa pun lagi setelah itu).
 * 4. BARU SETELAH itu tutup koneksi database/Redis — urutannya
 *    penting: request yang masih diproses di langkah 2 kemungkinan
 *    besar MASIH butuh koneksi ini; menutupnya lebih dulu akan
 *    menggagalkan request yang seharusnya sempat selesai dengan
 *    baik.
 *
 * Catatan: SDK OpenTelemetry (`shared/observability/tracing.ts`) dan
 * BullMQ producer connection punya listener `SIGTERM` SENDIRI-SENDIRI
 * yang didaftarkan terpisah — Node mengizinkan BANYAK listener untuk
 * sinyal yang sama, jadi tidak saling menimpa; keduanya tetap
 * berjalan berdampingan dengan shutdown di sini.
 */
const shutdown = createGuardedShutdown(shutdownImpl, (signal) =>
  logger.warn(`Menerima ${signal} saat shutdown sudah berjalan — diabaikan.`)
);

async function shutdownImpl(signal: string): Promise<void> {
  logger.info(`Menerima ${signal}, memulai graceful shutdown...`);
  setShuttingDown();

  const forceExitTimer = setTimeout(() => {
    logger.error(
      `Graceful shutdown melebihi batas waktu ${env.SHUTDOWN_TIMEOUT_MS}ms — keluar paksa`
    );
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  // `unref()` — timer ini TIDAK BOLEH menahan proses tetap hidup
  // kalau shutdown normal selesai LEBIH CEPAT dari timeout (tanpa
  // ini, proses akan menunggu penuh sampai `SHUTDOWN_TIMEOUT_MS`
  // walau sudah tidak ada pekerjaan tersisa).
  forceExitTimer.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    logger.info('HTTP server ditutup — seluruh request yang sedang berjalan sudah selesai.');

    await Promise.all([
      prisma.$disconnect(),
      prismaRead === prisma ? Promise.resolve() : prismaRead.$disconnect(),
      redisClient ? redisClient.quit() : Promise.resolve(),
      queueConnection ? queueConnection.quit() : Promise.resolve(),
    ]);
    logger.info('Koneksi database & Redis ditutup dengan bersih.');

    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Gagal shutdown dengan bersih');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * `uncaughtException` / `unhandledRejection` (P0 hardening).
 *
 * SEBELUMNYA proses ini TIDAK PUNYA handler untuk exception yang
 * lolos dari try/catch (mis. error di callback third-party) maupun
 * Promise rejection yang tidak ter-`catch`. Tanpa handler, Node akan
 * langsung menghentikan proses (untuk `uncaughtException`) TANPA
 * melalui `shutdown()` di atas sama sekali — bypass total mekanisme
 * graceful shutdown yang sudah dibangun (health check 503 dulu,
 * tunggu request selesai, tutup koneksi dengan bersih) DAN tanpa
 * error-nya sempat dilaporkan ke Sentry.
 *
 * PRINSIP: proses HARUS tetap exit setelah `uncaughtException` — state
 * proses sudah tidak reliable setelah exception yang tidak tertangani
 * (rekomendasi resmi Node.js), jadi handler ini TIDAK mencoba
 * "melanjutkan seperti biasa". Yang dilakukan hanya: catat error
 * (logger + Sentry) lalu masuk ke jalur `shutdown()` yang SAMA dengan
 * sinyal OS, supaya request yang sedang berjalan tetap diberi
 * kesempatan selesai (dibatasi `forceExitTimer`/`SHUTDOWN_TIMEOUT_MS`
 * yang sudah ada) alih-alih proses mati mendadak.
 *
 * `unhandledRejection` diperlakukan SAMA (exit, bukan sekadar log) —
 * versi Node modern sudah menjadikan ini fatal secara default kalau
 * tidak ditangani; menyamakan perilakunya di sini membuatnya predictable
 * terlepas dari flag runtime yang dipakai saat deploy.
 */
process.on('uncaughtException', (error) => {
  logger.fatal(
    { err: error },
    'uncaughtException — proses akan dihentikan dengan graceful shutdown'
  );
  Sentry.captureException(error);
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.fatal(
    { err: reason },
    'unhandledRejection — proses akan dihentikan dengan graceful shutdown'
  );
  Sentry.captureException(reason);
  void shutdown('unhandledRejection');
});
