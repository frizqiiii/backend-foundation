import { getOrSetCache, invalidateCache, invalidateByPattern } from './cache';
import { logger } from '../logger';
import { cacheOperationsTotal } from '../cache/cache.metrics';

/**
 * T-mutation (id=200/201/218/219/227/228, Fase 3.5) — `cache.spec.ts` men-mock
 * `redisClient` sebagai objek TRUTHY di SEMUA test-nya, jadi ketiga guard
 * `if (!redisClient)` di `getOrSetCache`/`invalidateCache`/`invalidateByPattern`
 * — yang justru menegakkan kontrak inti "Redis opsional" di seluruh proyek ini
 * (lihat komentar di `cache.ts` sendiri, dan T19/T21) — TIDAK PERNAH benar-benar
 * dijalankan jalur `!redisClient`-nya. File TERPISAH (bukan describe block baru
 * di `cache.spec.ts`) karena `jest.mock('../config/redis', ...)` di-hoist tetap
 * di level modul — tidak bisa mem-mock `redisClient` jadi truthy DAN `null`
 * sekaligus dalam satu file tanpa `isolateModules`, dan pola file terpisah ini
 * lebih sederhana serta konsisten dengan cara `cache.spec.ts` sendiri menjelaskan
 * keterbatasannya ("menguji cache.ts secara terisolasi, TIDAK menguji ioredis
 * sungguhan").
 */
jest.mock('../config/redis', () => ({ redisClient: null }));
jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const mockedLogger = logger as jest.Mocked<typeof logger>;

describe('cache utilities — redisClient === null (Redis tidak dikonfigurasi sama sekali)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheOperationsTotal.reset();
  });

  describe('getOrSetCache', () => {
    it('LANGSUNG memanggil fetcher (tidak pernah coba akses Redis), mengembalikan hasilnya apa adanya', async () => {
      const fetcher = jest.fn().mockResolvedValue({ id: 'langsung-dari-db' });

      const result = await getOrSetCache('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'langsung-dari-db' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('dicatat sebagai metric "miss" (bukan diam-diam tanpa metric sama sekali) — supaya operator tahu KENAPA hit ratio 0%', async () => {
      await getOrSetCache('key:1', 60, jest.fn().mockResolvedValue('x'));

      expect((await cacheOperationsTotal.get()).values).toEqual([
        expect.objectContaining({ labels: { key_prefix: 'key', result: 'miss' }, value: 1 }),
      ]);
    });

    it('TIDAK ada log warning apa pun — ini bukan kegagalan Redis, memang sengaja tidak dikonfigurasi', async () => {
      await getOrSetCache('key:1', 60, jest.fn().mockResolvedValue('x'));

      expect(mockedLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('invalidateCache', () => {
    it('resolve tanpa error (tidak melempar apa pun) walau tidak ada Redis untuk dihapus', async () => {
      await expect(invalidateCache('key:1')).resolves.toBeUndefined();
      expect(mockedLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('invalidateByPattern', () => {
    it('resolve tanpa error, TIDAK mencoba SCAN apa pun', async () => {
      await expect(invalidateByPattern('cache:events:*')).resolves.toBeUndefined();
      expect(mockedLogger.warn).not.toHaveBeenCalled();
    });
  });
});
