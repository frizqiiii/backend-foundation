import { Counter } from 'prom-client';
import { metricsRegistry } from '../../modules/monitoring/metrics/metrics.registry';

/**
 * Cache hit/miss ratio (Langkah 9 — Performance Audit) — sebelum ini
 * TIDAK ADA metric apa pun untuk mengukur efektivitas caching Redis
 * di aplikasi ini, padahal `getOrSetCache`/`getOrSetCacheWithTags`
 * sudah dipakai luas (`FeatureFlagService`, `TenantService`, dst).
 * Tanpa metric ini, tidak ada cara mengetahui dari Grafana apakah
 * sebuah cache key benar-benar efektif (hit ratio tinggi) atau
 * percuma dipasang (selalu miss, mis. TTL terlalu pendek dibanding
 * frekuensi akses) — satu-satunya cara sebelumnya adalah membaca
 * langsung dari Redis (`INFO stats` global, tidak per-key/per-domain).
 *
 * Label `key_prefix` (BUKAN `key` mentah) — sama alasannya dengan
 * `httpRequestsTotal` yang memakai path PATTERN bukan URL mentah:
 * memakai key cache utuh sebagai label akan membuat cardinality
 * metric meledak (satu time series baru per entity id yang pernah
 * di-cache). Prefix (segmen pertama sebelum `:` pertama, mis.
 * `feature-flags` dari key `feature-flags:tenant-abc`) sudah cukup
 * untuk melihat hit ratio PER DOMAIN cache tanpa risiko itu.
 */
export const cacheOperationsTotal = new Counter({
  name: 'cache_operations_total',
  help: 'Total operasi cache Redis, dipecah per prefix key dan hasilnya (hit/miss)',
  labelNames: ['key_prefix', 'result'] as const,
  registers: [metricsRegistry],
});

export function keyPrefix(key: string): string {
  const separatorIndex = key.indexOf(':');
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}

export function recordCacheHit(key: string): void {
  cacheOperationsTotal.inc({ key_prefix: keyPrefix(key), result: 'hit' });
}

export function recordCacheMiss(key: string): void {
  cacheOperationsTotal.inc({ key_prefix: keyPrefix(key), result: 'miss' });
}
