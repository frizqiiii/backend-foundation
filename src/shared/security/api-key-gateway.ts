import { redisClient } from '../config/redis';
import { logger } from '../logger';
import { TooManyRequestsError } from '../utils/http-error';
import { getRateLimitTier } from './rate-limit-tiers';
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
 * Item 2.11 (rate limit per-tier/plan) membangun DI ATAS modul ini:
 * kuota per menit sekarang bergantung pada plan tenant pemilik API
 * key (FREE/PRO/ENTERPRISE, lihat `rate-limit-tiers.ts`), bukan satu
 * angka statis untuk semua. `plan` tidak diketahui (`null`/
 * `undefined`) jatuh ke tier default (PRO = angka flat lama), jadi
 * perilaku sebelum item 2.11 tetap terjaga untuk key tanpa tenant.
 */

const WINDOW_SECONDS = 60;

function gatewayKey(apiKeyId: string): string {
  return `api-gateway:apikey:${apiKeyId}`;
}

export async function enforcePartnerApiGatewayLimit(
  apiKeyId: string,
  plan?: string | null
): Promise<void> {
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
    // Temuan T18 — TTL dan hitungan diset dalam SATU `MULTI/EXEC` atomik: `SET key 0 EX 60 NX` (hanya
    // membuat kunci + TTL bila belum ada; no-op bila sudah ada, jadi window TIDAK bergeser) lalu `INCR`.
    //
    // Pola lama `INCR` lalu `EXPIRE` (hanya bila hitungan == 1) adalah dua perintah terpisah. Kalau
    // `EXPIRE` gagal sekali saja (koneksi putus, failover Redis, proses mati di antara keduanya), kunci
    // hidup TANPA TTL: hitungan terus naik selamanya, tidak pernah `== 1` lagi sehingga TTL tidak pernah
    // diset ulang, dan begitu melewati batas API key itu ditolak PERMANEN sampai ada yang menghapus
    // kuncinya manual. Terbukti di Redis 7 sungguhan dengan `enforcePartnerApiGatewayLimit` asli dan
    // kegagalan `EXPIRE` yang disuntikkan sekali: `ttl = -1` dan hitungan 299 -> lolos, DITOLAK, DITOLAK.
    const results = await redisClient
      .multi()
      .set(key, 0, 'EX', WINDOW_SECONDS, 'NX')
      .incr(key)
      .exec();
    const incrResult = results?.[1];
    if (!incrResult || incrResult[0]) {
      throw incrResult?.[0] ?? new Error('MULTI/EXEC tidak mengembalikan hasil INCR');
    }
    count = Number(incrResult[1]);
  } catch (error) {
    logger.warn(
      { err: error, apiKeyId },
      'enforcePartnerApiGatewayLimit: Redis gagal — fail-open, kuota tidak ditegakkan untuk request ini'
    );
    partnerApiRequestsTotal.inc({ outcome: 'allowed_redis_error' });
    return;
  }

  const limit = getRateLimitTier(plan).apiKeyRequestsPerMinute;
  if (count > limit) {
    partnerApiRequestsTotal.inc({ outcome: 'rejected' });
    throw new TooManyRequestsError(
      `Kuota API key terlampaui (maks ${limit} request/menit). Coba lagi sesaat lagi.`
    );
  }

  partnerApiRequestsTotal.inc({ outcome: 'allowed' });
}
