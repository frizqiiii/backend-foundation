import { getOrSetCache, invalidateCache, invalidateByPattern } from './cache';
import { redisClient } from '../config/redis';
import { cacheOperationsTotal } from '../cache/cache.metrics';

/**
 * `redisClient` di-mock lewat factory eksplisit — file ini menguji
 * `cache.ts` secara terisolasi, TIDAK menguji `ioredis` sungguhan.
 * Verifikasi terhadap Redis nyata dilakukan terpisah (lihat catatan
 * di ringkasan) menggunakan instance Redis sungguhan di sandbox.
 */
jest.mock('../config/redis', () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
  },
}));

const mockedRedis = redisClient as jest.Mocked<NonNullable<typeof redisClient>>;

describe('cache utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheOperationsTotal.reset();
  });

  describe('getOrSetCache', () => {
    it('mengembalikan hasil JSON.parse ketika cache HIT, TANPA memanggil fetcher', async () => {
      mockedRedis.get.mockResolvedValue(JSON.stringify({ id: 'cached-1' }));
      const fetcher = jest.fn().mockResolvedValue({ id: 'fresh-1' });

      const result = await getOrSetCache('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'cached-1' });
      expect(fetcher).not.toHaveBeenCalled();
      expect((await cacheOperationsTotal.get()).values).toEqual([
        expect.objectContaining({ labels: { key_prefix: 'key', result: 'hit' }, value: 1 }),
      ]);
    });

    it('memanggil fetcher DAN menyimpan hasilnya ke cache ketika cache MISS', async () => {
      mockedRedis.get.mockResolvedValue(null);
      const fetcher = jest.fn().mockResolvedValue({ id: 'fresh-1' });

      const result = await getOrSetCache('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'fresh-1' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(mockedRedis.set).toHaveBeenCalledWith(
        'key:1',
        JSON.stringify({ id: 'fresh-1' }),
        'EX',
        60
      );
      expect((await cacheOperationsTotal.get()).values).toEqual([
        expect.objectContaining({ labels: { key_prefix: 'key', result: 'miss' }, value: 1 }),
      ]);
    });

    it('tetap mengembalikan hasil fetcher (BUKAN error) ketika Redis.get gagal', async () => {
      mockedRedis.get.mockRejectedValueOnce(new Error('connection refused'));
      const fetcher = jest.fn().mockResolvedValue({ id: 'fresh-1' });

      const result = await getOrSetCache('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'fresh-1' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('tetap mengembalikan hasil fetcher ketika Redis.set gagal (kegagalan menyimpan tidak boleh menggagalkan request)', async () => {
      mockedRedis.get.mockResolvedValue(null);
      mockedRedis.set.mockRejectedValueOnce(new Error('connection refused'));
      const fetcher = jest.fn().mockResolvedValue({ id: 'fresh-1' });

      const result = await getOrSetCache('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'fresh-1' });
    });

    it('meneruskan error dari fetcher apa adanya (bukan ditelan/di-cache sebagai hasil valid)', async () => {
      mockedRedis.get.mockResolvedValue(null);
      const fetcher = jest.fn().mockRejectedValue(new Error('database down'));

      await expect(getOrSetCache('key:1', 60, fetcher)).rejects.toThrow('database down');
      expect(mockedRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('invalidateCache', () => {
    it('menghapus key yang diberikan', async () => {
      await invalidateCache('key:1');
      expect(mockedRedis.del).toHaveBeenCalledWith('key:1');
    });

    it('tidak melempar error meski Redis.del gagal', async () => {
      mockedRedis.del.mockRejectedValueOnce(new Error('connection refused'));
      await expect(invalidateCache('key:1')).resolves.toBeUndefined();
    });
  });

  describe('invalidateByPattern', () => {
    it('menghapus SELURUH key yang cocok, melintasi banyak halaman SCAN (cursor)', async () => {
      mockedRedis.scan
        .mockResolvedValueOnce(['5', ['events:list:a', 'events:list:b']])
        .mockResolvedValueOnce(['0', ['events:list:c']]);

      await invalidateByPattern('events:list:*');

      expect(mockedRedis.scan).toHaveBeenCalledTimes(2);
      expect(mockedRedis.del).toHaveBeenNthCalledWith(1, 'events:list:a', 'events:list:b');
      expect(mockedRedis.del).toHaveBeenNthCalledWith(2, 'events:list:c');
    });

    it('tidak memanggil del sama sekali ketika tidak ada key yang cocok', async () => {
      mockedRedis.scan.mockResolvedValueOnce(['0', []]);

      await invalidateByPattern('events:list:*');

      expect(mockedRedis.del).not.toHaveBeenCalled();
    });
  });
});
