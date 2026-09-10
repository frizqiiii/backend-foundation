import type { FeatureFlagRepository } from './feature-flag.repository';
import type { FeatureFlagDto, UpsertFeatureFlagInput } from './feature-flag.dto';
import { getOrSetCache, invalidateCache } from '../../shared/utils/cache';
import { cacheKeys } from '../../shared/utils/cache-keys';

/**
 * Feature Flag Service (Phase 16 upgrade).
 *
 * `isEnabled()` di-cache lewat Redis (`getOrSetCache`, TTL pendek) —
 * SENGAJA, karena method ini didesain untuk dipanggil kode LAIN di
 * hot path request (mis. `if (await featureFlagService.isEnabled(
 * 'new-checkout-flow')) {...}` di Service modul manapun), bukan
 * hanya dari endpoint admin. Tanpa cache, setiap flag check akan jadi
 * satu query database tambahan di request yang sama sekali tidak
 * berhubungan dengan pengelolaan flag itu sendiri.
 *
 * TTL SENGAJA pendek (30 detik, bukan menitan/jaman) — flag adalah
 * kill-switch operasional; delay propagasi yang lama antara admin
 * men-toggle flag dan efeknya benar-benar terasa mengurangi
 * gunanya sebagai kill-switch darurat.
 */
const CACHE_TTL_SECONDS = 30;

export class FeatureFlagService {
  constructor(private readonly featureFlagRepository: FeatureFlagRepository) {}

  async listAll(): Promise<FeatureFlagDto[]> {
    return this.featureFlagRepository.findAll();
  }

  /**
   * Flag yang BELUM PERNAH dibuat di database dianggap `false`
   * (fail-closed) — konsisten dengan default kolom `enabled` di
   * schema (`@default(false)`), dan lebih aman: fitur baru yang
   * belum sempat diberi flag eksplisit tidak tiba-tiba aktif untuk
   * semua orang.
   */
  async isEnabled(key: string): Promise<boolean> {
    return getOrSetCache(cacheKeys.featureFlag(key), CACHE_TTL_SECONDS, async () => {
      const flag = await this.featureFlagRepository.findByKey(key);
      return flag?.enabled ?? false;
    });
  }

  async upsert(key: string, input: UpsertFeatureFlagInput): Promise<FeatureFlagDto> {
    const flag = await this.featureFlagRepository.upsert(key, input);
    // Invalidate SEGERA setelah write — menunggu TTL 30 detik habis
    // secara alami akan membuat admin yang baru saja men-toggle flag
    // masih melihat perilaku LAMA sesaat, membingungkan saat testing
    // manual pasca-toggle.
    await invalidateCache(cacheKeys.featureFlag(key));
    return flag;
  }
}
