import { redisClient } from '../config/redis';
import { logger } from '../logger';
import { env } from '../config/env';
import { TooManyRequestsError } from '../utils/http-error';
import { partnerApiRequestsTotal } from '../../modules/monitoring/metrics/metrics.registry';

/**
 * Fase 2 (Kelompok 2, item 2.10 — API Gateway/BFF).
 *
 * Project ini monolith (bukan microservices) — "API Gateway" klasik
 * (routing antar service, transformasi protokol) tidak relevan di
 * sini, mayoritas tanggung jawab gateway (auth terpusat, rate limit,
 * circuit breaker) sudah melekat di Express app ini sendiri. Yang
 * SECARA NYATA belum ada: batas EDGE yang membedakan traffic partner/
 * developer eksternal (lewat API key, `req.user.apiKeyScopes`
 * terisi — lihat `auth.middleware.ts`) dari traffic user biasa
 * (lewat sesi login) — keduanya SAAT INI diperlakukan identik oleh
 * `rate-limiter.ts` (limit per-IP/tenant, tidak peduli jalur
 * autentikasinya).
 *
 * Modul ini menutup celah itu: SATU titik terpusat (dipanggil dari
 * `authMiddleware` PERSIS di jalur API key, bukan di-mount ulang per
 * rute) yang menegakkan kuota tersendiri PER API KEY (bukan per-IP —
 * satu partner bisa punya banyak IP), plus metric Prometheus khusus
 * untuk observability volume traffic partner API secara terpisah
 * dari traffic umum.
 *
 * FAIL-OPEN (BUKAN fail-closed) kalau Redis tidak terjangkau — pola
 * SAMA dengan `rate-limiter.ts` (`passOnStoreError: true`): satu
 * dependency opsional yang down TIDAK BOLEH menolak SELURUH traffic
 * partner API, cuma berarti kuota-nya untuk sesaat tidak ditegakkan.
 * Item 2.11 (rate limit per-tier/plan, belum dikerjakan) akan
 * membangun DI ATAS modul ini — menambahkan limit yang BERBEDA per
 * tier/plan API key, bukan satu angka statis untuk semua seperti
 * sekarang.
 */

const WINDOW_SECONDS = 60;

function gatewayKey(apiKeyId: string): string {
  return `api-gateway:apikey:${apiKeyId}`;
}

export async function enforcePartnerApiGatewayLimit(apiKeyId: string): Promise<void> {
  if (!redisClient) {
    // Fail-open TANPA Redis sama sekali (konsisten dengan seluruh
    // fitur berbasis Redis lain di project ini) — tapi TETAP dicatat
    // ke metric supaya volume partner API tetap terlihat di
    // observability meski kuotanya tidak ditegakkan.
    partnerApiRequestsTotal.inc({ outcome: 'allowed_no_redis' });
    return;
  }

  const key = gatewayKey(apiKeyId);
  let count: number;
  try {
    count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, WINDOW_SECONDS);
    }
  } catch (error) {
    logger.warn(
      { err: error, apiKeyId },
      'enforcePartnerApiGatewayLimit: Redis gagal — fail-open, kuota tidak ditegakkan untuk request ini'
    );
    partnerApiRequestsTotal.inc({ outcome: 'allowed_redis_error' });
    return;
  }

  if (count > env.API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE) {
    partnerApiRequestsTotal.inc({ outcome: 'rejected' });
    throw new TooManyRequestsError(
      `Kuota API key terlampaui (maks ${env.API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE} request/menit). Coba lagi sesaat lagi.`
    );
  }

  partnerApiRequestsTotal.inc({ outcome: 'allowed' });
}
