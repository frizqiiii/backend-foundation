import { FeatureFlagService } from './feature-flag.service';
import type { FeatureFlagRepository } from './feature-flag.repository';

/**
 * `redisClient` bernilai `null` di lingkungan test (`REDIS_URL` tidak
 * di-set di `jest.setup.ts`) — `getOrSetCache` otomatis fallback
 * langsung ke `fetcher()` tanpa cache, jadi test ini TIDAK perlu
 * mock `shared/utils/cache` sama sekali, cukup mock Repository.
 */
describe('FeatureFlagService', () => {
  let featureFlagRepository: jest.Mocked<FeatureFlagRepository>;
  let featureFlagService: FeatureFlagService;

  const dummyFlag = {
    id: 'flag-1',
    key: 'new-checkout-flow',
    enabled: true,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    featureFlagRepository = {
      findAll: jest.fn(),
      findByKey: jest.fn(),
      upsert: jest.fn(),
    } as unknown as jest.Mocked<FeatureFlagRepository>;

    featureFlagService = new FeatureFlagService(featureFlagRepository);
  });

  describe('isEnabled', () => {
    it('mengembalikan true kalau flag ada di database dan enabled', async () => {
      featureFlagRepository.findByKey.mockResolvedValue(dummyFlag);

      const result = await featureFlagService.isEnabled('new-checkout-flow');

      expect(result).toBe(true);
    });

    it('mengembalikan false (fail-closed) kalau flag belum pernah dibuat', async () => {
      featureFlagRepository.findByKey.mockResolvedValue(null);

      const result = await featureFlagService.isEnabled('flag-yang-tidak-ada');

      expect(result).toBe(false);
    });
  });

  describe('upsert', () => {
    it('meneruskan key & input ke repository, mengembalikan hasilnya', async () => {
      featureFlagRepository.upsert.mockResolvedValue(dummyFlag);

      const result = await featureFlagService.upsert('new-checkout-flow', { enabled: true });

      expect(featureFlagRepository.upsert).toHaveBeenCalledWith('new-checkout-flow', {
        enabled: true,
      });
      expect(result).toEqual(dummyFlag);
    });
  });

  describe('listAll', () => {
    it('mengembalikan seluruh flag dari repository', async () => {
      featureFlagRepository.findAll.mockResolvedValue([dummyFlag]);

      const result = await featureFlagService.listAll();

      expect(result).toEqual([dummyFlag]);
    });
  });
});
