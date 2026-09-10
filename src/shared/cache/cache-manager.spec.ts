import {
  getOrSetCacheWithTags,
  invalidateTag,
  getOrSetCacheWithStampedeProtection,
} from './cache-manager';
import { redisClient } from '../config/redis';

jest.mock('../config/redis', () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
    smembers: jest.fn(),
    pipeline: jest.fn(),
    eval: jest.fn(),
  },
}));

const mockedRedis = redisClient as jest.Mocked<NonNullable<typeof redisClient>>;

describe('cache-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getOrSetCacheWithTags', () => {
    it('mendaftarkan key ke setiap tag lewat pipeline sadd+expire', async () => {
      mockedRedis.get.mockResolvedValue(null);
      const pipelineExec = jest.fn().mockResolvedValue([]);
      const pipeline = {
        sadd: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: pipelineExec,
      };
      mockedRedis.pipeline.mockReturnValue(pipeline as never);

      const result = await getOrSetCacheWithTags(
        'products:list:page1',
        60,
        ['products', 'category:electronics'],
        async () => ({ items: [] })
      );

      expect(result).toEqual({ items: [] });
      expect(pipeline.sadd).toHaveBeenCalledWith('cache:tag:products', 'products:list:page1');
      expect(pipeline.sadd).toHaveBeenCalledWith(
        'cache:tag:category:electronics',
        'products:list:page1'
      );
      expect(pipelineExec).toHaveBeenCalledTimes(1);
    });

    it('tidak memanggil pipeline sama sekali kalau tags kosong', async () => {
      mockedRedis.get.mockResolvedValue(null);

      await getOrSetCacheWithTags('products:list:page1', 60, [], async () => ({ items: [] }));

      expect(mockedRedis.pipeline).not.toHaveBeenCalled();
    });
  });

  describe('invalidateTag', () => {
    it('menghapus seluruh key anggota tag PLUS set tag itu sendiri', async () => {
      mockedRedis.smembers.mockResolvedValue(['products:list:page1', 'products:list:page2']);

      await invalidateTag('products');

      expect(mockedRedis.del).toHaveBeenCalledWith('products:list:page1', 'products:list:page2');
      expect(mockedRedis.del).toHaveBeenCalledWith('cache:tag:products');
    });

    it('tidak error kalau tag tidak punya anggota sama sekali', async () => {
      mockedRedis.smembers.mockResolvedValue([]);

      await expect(invalidateTag('products')).resolves.toBeUndefined();
      expect(mockedRedis.del).toHaveBeenCalledWith('cache:tag:products');
    });

    it('tidak melempar error kalau Redis gagal', async () => {
      mockedRedis.smembers.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(invalidateTag('products')).resolves.toBeUndefined();
    });
  });

  describe('getOrSetCacheWithStampedeProtection', () => {
    it('mengembalikan cache langsung kalau HIT, tanpa mengambil lock', async () => {
      mockedRedis.get.mockResolvedValue(JSON.stringify({ id: 1 }));
      const fetcher = jest.fn();

      const result = await getOrSetCacheWithStampedeProtection('key:1', 60, fetcher);

      expect(result).toEqual({ id: 1 });
      expect(fetcher).not.toHaveBeenCalled();
      expect(mockedRedis.set).not.toHaveBeenCalled();
    });

    it('mengambil lock dan menjalankan fetcher ketika MISS dan lock berhasil diambil', async () => {
      mockedRedis.get.mockResolvedValue(null);
      mockedRedis.set.mockResolvedValue('OK');
      const fetcher = jest.fn().mockResolvedValue({ id: 'fresh' });

      const result = await getOrSetCacheWithStampedeProtection('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'fresh' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('menunggu lalu membaca ulang cache (BUKAN memanggil fetcher) ketika lock sedang dipegang request lain', async () => {
      mockedRedis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ id: 'from-other-request' }));
      mockedRedis.set.mockResolvedValue(null);
      const fetcher = jest.fn();

      const result = await getOrSetCacheWithStampedeProtection('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'from-other-request' });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('fallback menjalankan fetcher sendiri kalau menunggu terlalu lama tanpa cache terisi', async () => {
      mockedRedis.get.mockResolvedValue(null);
      mockedRedis.set.mockResolvedValue(null);
      const fetcher = jest.fn().mockResolvedValue({ id: 'fallback' });

      const result = await getOrSetCacheWithStampedeProtection('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'fallback' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }, 10000);
  });
});
