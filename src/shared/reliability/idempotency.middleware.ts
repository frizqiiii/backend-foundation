import type { Request, Response, NextFunction } from 'express';
import { redisClient } from '../config/redis';
import { withLock } from '../concurrency/distributed-lock';
import { logger } from '../logger';
import { getResponseLocale } from '../i18n/locale';
import { translateMessage } from '../i18n/translate';

/**
 * Idempotency Key + Request Deduplication (Phase 18 — Enterprise
 * Reliability). Dua requirement TERPISAH di checklist Phase 18, tapi
 * SENGAJA digabung jadi satu middleware — mekanismenya nyaris
 * identik (keduanya butuh tempat menyimpan "request dengan key X
 * sudah/sedang diproses"), memisahkannya jadi dua middleware hanya
 * akan menduplikasi state tanpa manfaat:
 *
 * - IDEMPOTENCY KEY: kalau client mengirim ulang request yang PERSIS
 *   sama (mis. retry karena response sebelumnya tidak sampai ke
 *   client walau sudah sukses diproses server) dengan header
 *   `Idempotency-Key` yang SAMA, server mengembalikan response yang
 *   SAMA PERSIS dengan percobaan pertama — TANPA menjalankan handler
 *   lagi (mis. tidak membuat resource dua kali).
 * - REQUEST DEDUPLICATION: kalau DUA request dengan key yang sama
 *   datang BERSAMAAN (bukan berurutan — mis. client yang double-klik,
 *   atau dua tab), request KEDUA tidak boleh ikut menjalankan handler
 *   sama sekali selagi yang pertama masih diproses (bukan cuma
 *   dicegah SETELAH yang pertama selesai, seperti kasus idempotency
 *   key murni) — inilah yang butuh `withLock` (Redis, sudah ada dari
 *   Phase 14), bukan sekadar cache biasa.
 *
 * OPT-IN, bukan wajib global — HANYA aktif untuk request yang
 * mengirim header `Idempotency-Key` secara eksplisit. Endpoint yang
 * ingin mendukung ini cukup memasang `idempotencyMiddleware()` di
 * route-nya (lihat contoh pemakaian di `webhook.routes.ts`); endpoint
 * lain sama sekali tidak terpengaruh.
 *
 * FAIL-OPEN tanpa Redis — SAMA filosofinya dengan seluruh fitur
 * berbasis Redis lain di aplikasi ini (cache, distributed lock, rate
 * limiter): tanpa `REDIS_URL`, idempotency/dedup TIDAK AKTIF (request
 * diproses apa adanya, tanpa proteksi ini) alih-alih menolak seluruh
 * request atau membuat aplikasi bergantung keras pada Redis.
 */

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const IDEMPOTENCY_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 jam — cukup untuk menutup skenario retry realistis (mis. client yang retry setelah timeout jaringan beberapa menit), tanpa menyimpan response selamanya.
const LOCK_TTL_MS = 30_000; // Selaras dengan asumsi "request wajar selesai dalam puluhan detik" yang sama dipakai timeout provider eksternal (lihat `reliability/policies.ts`) — request yang lebih lama dari ini kemungkinan sudah bermasalah, lock sebaiknya kedaluwarsa sendiri daripada mengunci selamanya kalau proses yang memegangnya crash.

interface CachedResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyMiddlewareOptions {
  /** Prefix key Redis — unik per route/resource supaya `Idempotency-Key` yang sama di endpoint BERBEDA tidak saling bentrok. */
  scope: string;
}

export function idempotencyMiddleware(
  options: IdempotencyMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.header(IDEMPOTENCY_KEY_HEADER);
    const redis = redisClient;

    if (!idempotencyKey || !redis) {
      next();
      return;
    }

    // Ikut menyertakan `userId` (kalau ada) di cache key — MENCEGAH
    // dua user berbeda yang KEBETULAN mengirim string
    // `Idempotency-Key` yang sama (mis. keduanya generate UUID lewat
    // library yang sama tapi kebetulan bentrok, atau client yang
    // salah implementasi memakai konstanta) saling membaca response
    // satu sama lain.
    const userId = req.user?.id ?? 'anonymous';
    const cacheKey = `idempotency:${options.scope}:${userId}:${idempotencyKey}`;

    const cached = await redis.get(cacheKey).catch((error: unknown) => {
      logger.warn(
        { err: error, cacheKey },
        'IdempotencyMiddleware: gagal membaca cache Redis — fail-open'
      );
      return null;
    });

    if (cached) {
      const response = JSON.parse(cached) as CachedResponse;
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(response.statusCode).json(response.body);
      return;
    }

    // `withLock` — REQUEST DEDUPLICATION: kalau request LAIN dengan
    // key yang SAMA sedang diproses saat ini juga (`ran: false`),
    // request ini TIDAK menjalankan handler sama sekali, langsung
    // ditolak dengan 409 — pemanggil (client) diharapkan retry
    // sebentar lagi, saat itu percobaan pertama kemungkinan sudah
    // selesai dan responsnya sudah ada di cache (jalur `cached` di
    // atas).
    const lockResult = await withLock(`idempotency:${cacheKey}`, LOCK_TTL_MS, async () => {
      // Bungkus `res.json` — tangkap response yang DIHASILKAN handler
      // di bawah, simpan ke Redis SEBELUM benar-benar dikirim ke
      // client, supaya request idempotency berikutnya (setelah lock
      // ini dilepas) langsung menemukan cache-nya.
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode < 400) {
          const toCache: CachedResponse = { statusCode: res.statusCode, body };
          redis
            .set(cacheKey, JSON.stringify(toCache), 'EX', IDEMPOTENCY_CACHE_TTL_SECONDS)
            .catch((error: unknown) => {
              logger.warn(
                { err: error, cacheKey },
                'IdempotencyMiddleware: gagal menyimpan response ke cache Redis'
              );
            });
        }
        return originalJson(body);
      }) as Response['json'];

      await new Promise<void>((resolve) => {
        res.once('finish', resolve);
        next();
      });
    });

    if (!lockResult.ran) {
      res.status(409).json({
        success: false,
        // Fase 2 (item 2.13 — i18n): diterjemahkan sesuai locale request.
        message: translateMessage(
          'Request dengan Idempotency-Key yang sama sedang diproses. Coba lagi sesaat lagi.',
          getResponseLocale(res)
        ),
      });
    }
  };
}
