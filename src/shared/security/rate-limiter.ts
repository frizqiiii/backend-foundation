import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { RedisStore } from 'rate-limit-redis';
import { redisClient } from '../config/redis';
import { TooManyRequestsError } from '../utils/http-error';

interface CreateRateLimiterOptions {
  windowMs: number;
  max: number;
  message: string;
  /** Prefix key Redis — WAJIB unik per limiter supaya hitungan rate-limit auth tidak bercampur dengan limiter umum. */
  keyPrefix: string;
  /**
   * Phase 18 (Rate Limit per Tenant) — SENGAJA opsional, default-nya
   * (tidak diisi) tetap perilaku LAMA: `express-rate-limit` memakai
   * `req.ip` sebagai key, artinya kuota dihitung PER-IP. Diisi custom
   * kalau limiter ini butuh dimensi lain (mis. per-tenant, lihat
   * `tenantRateLimiter` di `app.ts`) — TIDAK menggantikan limiter
   * per-IP yang sudah ada, melainkan LAPISAN TAMBAHAN dengan dimensi
   * berbeda.
   */
  keyGenerator?: (req: Request) => string;
  /** Lewati limiter ini untuk request tertentu (mis. tidak ada tenant context aktif — tidak ada yang perlu dibatasi per-tenant). */
  skip?: (req: Request) => boolean;
}

/**
 * Rate limiter berbasis Redis — dipakai untuk SEMUA limiter di
 * aplikasi ini (bukan cuma auth), supaya kalau `backend_app`
 * di-scale ke banyak instance (PM2 cluster mode/banyak container di
 * belakang load balancer), hitungan rate limit tetap KONSISTEN lintas
 * instance. Tanpa Redis store, tiap instance punya `MemoryStore`
 * sendiri-sendiri — efeknya limit sungguhan jadi terkalikan sebanyak
 * jumlah instance (mis. limit "10 per 15 menit" dengan 4 instance
 * jadi efektif 40 per 15 menit, karena tiap instance menghitung dari
 * nol).
 *
 * Redis tetap OPSIONAL (fallback ke `MemoryStore` bawaan
 * `express-rate-limit` kalau `REDIS_URL` kosong) — konsisten dengan
 * seluruh fitur berbasis Redis lain di aplikasi ini (cache, queue):
 * rate limiting tetap aktif tanpa Redis, hanya kehilangan konsistensi
 * lintas-instance yang memang tidak relevan untuk deployment single-
 * instance/development.
 */
export function createRateLimiter(options: CreateRateLimiterOptions): ReturnType<typeof rateLimit> {
  const redis = redisClient;

  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    ...(options.skip ? { skip: options.skip } : {}),
    store: redis
      ? new RedisStore({
          prefix: `rate_limit:${options.keyPrefix}:`,
          // `ioredis` menyediakan `.call()` untuk mengirim raw command
          // Redis apa pun — persis kontrak `sendCommand` yang diminta
          // `rate-limit-redis` (library ini didesain client-agnostic,
          // tidak spesifik ke satu library Redis tertentu). Signature
          // `.call()` milik ioredis tidak menerima array biasa lewat
          // spread (butuh tuple), jadi argumen diteruskan lewat
          // `.call(command, ...rest)` yang cocok dengan overload-nya.
          sendCommand: (...args: string[]) => {
            const [command, ...rest] = args;
            return redis.call(command, ...rest) as Promise<
              string | number | Array<string | number>
            >;
          },
        })
      : undefined,
    // Handler kustom melempar `TooManyRequestsError` lewat `next()`,
    // BUKAN membiarkan `express-rate-limit` membentuk response
    // sendiri — supaya response tetap konsisten lewat `errorHandler`
    // terpusat yang sama dengan seluruh error lain di aplikasi.
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError(options.message));
    },
  });
}
