import type { Request, Response } from 'express';
import { prisma } from '../../../shared/config/database';
import { redisClient } from '../../../shared/config/redis';
import { queueConnection } from '../../../shared/queue/connection';
import { logger } from '../../../shared/logger';
import { env } from '../../../shared/config/env';

const startedAt = process.hrtime.bigint();

/**
 * `GET /health` — LIVENESS check: "apakah proses ini masih hidup dan
 * bisa membalas HTTP sama sekali?". SENGAJA tidak menyentuh dependency
 * eksternal apa pun (database, Redis, dst) — kalau liveness check ikut
 * bergantung ke database yang lambat/down, orchestrator (Kubernetes,
 * dst) bisa salah kesimpulan "proses ini mati" lalu me-restart proses
 * yang sebenarnya sehat, hanya karena database-nya yang bermasalah.
 * Restart loop akibat liveness check yang terlalu "pintar" adalah
 * kesalahan umum — bedakan tegas dari `/ready` di bawah.
 */
export function getHealth(_req: Request, res: Response): void {
  const uptimeSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const memoryUsage = process.memoryUsage();

  res.status(200).json({
    status: 'ok',
    uptime: Math.round(uptimeSeconds),
    memory: {
      rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
      heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  });
}

interface DependencyCheckResult {
  status: 'ok' | 'error' | 'not_configured';
  latencyMs?: number;
  message?: string;
}

/**
 * Membungkus satu pengecekan dependency dengan timeout & pengukuran
 * latency seragam — dipakai untuk ketiga dependency di bawah (Postgres,
 * Redis, Queue) supaya perilakunya konsisten: dependency yang lambat
 * TIDAK boleh membuat `/ready` menggantung tanpa batas waktu.
 */
async function checkDependency(
  name: string,
  check: () => Promise<void>,
  timeoutMs = 3000
): Promise<DependencyCheckResult> {
  const startedAtCheck = process.hrtime.bigint();
  try {
    await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`Timeout setelah ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    const latencyMs = Number(process.hrtime.bigint() - startedAtCheck) / 1e6;
    return { status: 'ok', latencyMs: Math.round(latencyMs) };
  } catch (error) {
    logger.warn({ err: error, dependency: name }, 'Readiness check gagal');
    // Finding #23 (P1 Security Hardening, Error/Information Disclosure)
    // — SEBELUMNYA `error.message` APA ADANYA dikirim ke response
    // `/ready`, endpoint PUBLIK TANPA autentikasi (lihat
    // `health.routes.ts`) yang memang sengaja dibuat begitu untuk
    // orchestrator/load-balancer — SIAPA PUN yang bisa akses aplikasi
    // ini lewat jaringan bisa memicu kegagalan ini dan membaca pesan
    // error driver PostgreSQL/Redis/BullMQ APA ADANYA, terlepas dari
    // `NODE_ENV`. Pesan error driver database SERING memuat detail
    // internal (hostname/IP internal, port, nama database, kadang
    // fragmen kredensial di pesan auth-failure) — persis kategori
    // "Error/Information Disclosure" yang harusnya sudah ditutup
    // `errorHandler.ts` untuk endpoint LAIN, tapi endpoint ini
    // membentuk response-nya SENDIRI (tidak lewat `errorHandler`),
    // jadi redaksinya harus ditegakkan terpisah, DI SINI. Detail
    // lengkapnya TETAP ada — di `logger.warn` di atas, yang hanya
    // dilihat operator lewat log, bukan siapa pun yang mengakses
    // endpoint publik ini.
    return {
      status: 'error',
      message:
        env.NODE_ENV === 'production'
          ? 'Dependency tidak sehat'
          : error instanceof Error
            ? error.message
            : 'Unknown error',
    };
  }
}

/**
 * `GET /ready` — READINESS check: "apakah proses ini siap MENERIMA
 * traffic saat ini juga?". Berbeda dari `/health`, endpoint ini
 * MEMANG menyentuh dependency eksternal — kalau PostgreSQL tidak
 * terjangkau, aplikasi memang tidak siap melayani sebagian besar
 * endpoint bisnis, dan orchestrator sebaiknya berhenti mengarahkan
 * traffic ke instance ini (bukan me-restart-nya — bedanya dengan
 * liveness).
 *
 * Redis & Queue diperiksa tapi TIDAK membuat keseluruhan response
 * berstatus 503 kalau keduanya down — konsisten dengan `redis.ts` &
 * `queue/connection.ts` yang sudah mendesain keduanya sebagai
 * dependency OPSIONAL (aplikasi tetap bisa melayani request inti
 * tanpanya, hanya kehilangan cache/queue). Hanya PostgreSQL yang
 * kegagalannya menjatuhkan status keseluruhan ke `error` — itu
 * satu-satunya dependency yang benar-benar wajib.
 */
// Phase 18 (Enterprise Reliability — Graceful Shutdown) — flag proses
// TUNGGAL, di-set `server.ts` begitu SIGTERM/SIGINT diterima, SEBELUM
// `httpServer.close()` dipanggil. Tujuannya: begitu proses mulai
// shutdown, `/ready` LANGSUNG melaporkan 503 tanpa perlu menunggu
// query dependency (database/Redis) sama sekali — load
// balancer/Kubernetes yang polling `/ready` secara berkala akan
// berhenti mengirim traffic BARU ke instance ini secepat mungkin,
// sementara request yang SUDAH masuk tetap diberi waktu selesai
// (lihat `SHUTDOWN_TIMEOUT_MS` di `server.ts`). `/health` (liveness)
// SENGAJA TIDAK ikut terpengaruh flag ini — proses masih hidup dan
// sehat, hanya sedang menolak pekerjaan BARU.
let isShuttingDown = false;

export function setShuttingDown(): void {
  isShuttingDown = true;
}

export async function getReadiness(_req: Request, res: Response): Promise<void> {
  if (isShuttingDown) {
    res.status(503).json({
      status: 'not_ready',
      message: 'Proses sedang shutdown',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const redis = redisClient;
  const queue = queueConnection;

  const [database, redisResult, queueResult] = await Promise.all([
    checkDependency('postgresql', async () => {
      await prisma.$queryRaw`SELECT 1`;
    }),
    redis
      ? checkDependency('redis', async () => {
          await redis.ping();
        })
      : Promise.resolve<DependencyCheckResult>({ status: 'not_configured' }),
    queue
      ? checkDependency('queue', async () => {
          await queue.ping();
        })
      : Promise.resolve<DependencyCheckResult>({ status: 'not_configured' }),
  ]);

  const isReady = database.status === 'ok';

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    checks: { database, redis: redisResult, queue: queueResult },
    timestamp: new Date().toISOString(),
  });
}
