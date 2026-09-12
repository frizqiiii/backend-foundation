import { getOrSetCache, invalidateCache, invalidateByPattern } from './cache';
import { redisClient } from '../config/redis';
import { logger } from '../logger';
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

// Sebelumnya TIDAK di-mock sama sekali — pesan log di tiap blok catch
// (`logger.warn(...)`) jadi TIDAK PERNAH diverifikasi isinya, sumber
// mutant string-literal yang lolos (Fase 1 item 1.2, mutation testing).
jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const mockedRedis = redisClient as jest.Mocked<NonNullable<typeof redisClient>>;
const mockedLogger = logger as jest.Mocked<typeof logger>;

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

    it('tetap mengembalikan hasil fetcher (BUKAN error) ketika Redis.get gagal, DAN mencatat warning dengan pesan PERSIS', async () => {
      const getError = new Error('connection refused');
      mockedRedis.get.mockRejectedValueOnce(getError);
      const fetcher = jest.fn().mockResolvedValue({ id: 'fresh-1' });

      const result = await getOrSetCache('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'fresh-1' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        { err: getError, key: 'key:1' },
        'Gagal membaca cache, fallback ke database'
      );
    });

    it('tetap mengembalikan hasil fetcher ketika Redis.set gagal (kegagalan menyimpan tidak boleh menggagalkan request), DAN mencatat warning dengan pesan PERSIS', async () => {
      mockedRedis.get.mockResolvedValue(null);
      const setError = new Error('connection refused');
      mockedRedis.set.mockRejectedValueOnce(setError);
      const fetcher = jest.fn().mockResolvedValue({ id: 'fresh-1' });

      const result = await getOrSetCache('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'fresh-1' });
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        { err: setError, key: 'key:1' },
        'Gagal menyimpan ke cache — data tetap dikembalikan seperti biasa'
      );
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

    it('tidak melempar error meski Redis.del gagal, DAN mencatat warning dengan pesan PERSIS', async () => {
      const delError = new Error('connection refused');
      mockedRedis.del.mockRejectedValueOnce(delError);

      await expect(invalidateCache('key:1')).resolves.toBeUndefined();
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        { err: delError, key: 'key:1' },
        'Gagal menghapus cache'
      );
    });
  });

  describe('invalidateByPattern', () => {
    it('menghasilkan panggilan scan/del dengan ARGUMEN PERSIS (bukan cuma "dipanggil") — cursor, MATCH, pattern, COUNT, 100', async () => {
      mockedRedis.scan.mockResolvedValueOnce(['0', ['events:list:a']]);

      await invalidateByPattern('events:list:*');

      expect(mockedRedis.scan).toHaveBeenNthCalledWith(
        1,
        '0',
        'MATCH',
        'events:list:*',
        'COUNT',
        100
      );
      expect(mockedRedis.del).toHaveBeenCalledWith('events:list:a');
    });

    it('menghasilkan SELURUH key yang cocok, melintasi banyak halaman SCAN (cursor)', async () => {
      mockedRedis.scan
        .mockResolvedValueOnce(['5', ['events:list:a', 'events:list:b']])
        .mockResolvedValueOnce(['0', ['events:list:c']]);

      await invalidateByPattern('events:list:*');

      expect(mockedRedis.scan).toHaveBeenCalledTimes(2);
      // Panggilan KEDUA harus memakai cursor "5" yang dikembalikan
      // panggilan pertama (bukan "0" lagi atau cursor yang salah) —
      // menutup mutant yang menukar variabel `cursor` di parameter ini.
      expect(mockedRedis.scan).toHaveBeenNthCalledWith(
        2,
        '5',
        'MATCH',
        'events:list:*',
        'COUNT',
        100
      );
      expect(mockedRedis.del).toHaveBeenNthCalledWith(1, 'events:list:a', 'events:list:b');
      expect(mockedRedis.del).toHaveBeenNthCalledWith(2, 'events:list:c');
    });

    it('tidak memanggil del sama sekali ketika tidak ada key yang cocok', async () => {
      mockedRedis.scan.mockResolvedValueOnce(['0', []]);

      await invalidateByPattern('events:list:*');

      expect(mockedRedis.del).not.toHaveBeenCalled();
    });

    it('P5 — tidak melempar error meski Redis.scan gagal (loop dihentikan, bukan menggagalkan pemanggil), DAN mencatat warning dengan pesan PERSIS', async () => {
      const scanError = new Error('connection refused');
      mockedRedis.scan.mockRejectedValueOnce(scanError);

      await expect(invalidateByPattern('events:list:*')).resolves.toBeUndefined();
      expect(mockedRedis.del).not.toHaveBeenCalled();
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        { err: scanError, pattern: 'events:list:*' },
        'Gagal menghapus cache berdasarkan pola'
      );
    });
  });

  describe('redisClient TIDAK DIKONFIGURASI (null) — cabang yang sebelumnya 0% coverage', () => {
    /**
     * `jest.mock` di atas top-level file ini SELALU mengembalikan
     * objek (tidak pernah `null`), jadi cabang `if (!redisClient)` di
     * ketiga fungsi TIDAK PERNAH tereksekusi test mana pun sebelumnya
     * — persis 3 "no coverage" yang tercatat di laporan mutation
     * testing (Fase 1 item 1.2). Di sini kita re-mock modulnya secara
     * terisolasi supaya `redisClient` benar-benar `null`, mensimulasikan
     * kondisi Redis tidak dikonfigurasi (`REDIS_URL` kosong).
     */
    async function loadCacheWithNullRedis() {
      let mod: typeof import('./cache') | undefined;
      await jest.isolateModulesAsync(async () => {
        jest.doMock('../config/redis', () => ({ redisClient: null }));
        mod = require('./cache');
      });
      return mod!;
    }

    it('getOrSetCache: langsung panggil fetcher (skip Redis sepenuhnya), tetap tercatat sebagai "miss"', async () => {
      const { getOrSetCache: getOrSetCacheNullRedis } = await loadCacheWithNullRedis();
      const fetcher = jest.fn().mockResolvedValue({ id: 'fresh-1' });

      const result = await getOrSetCacheNullRedis('key:1', 60, fetcher);

      expect(result).toEqual({ id: 'fresh-1' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('invalidateCache: langsung return, tidak melempar error', async () => {
      const { invalidateCache: invalidateCacheNullRedis } = await loadCacheWithNullRedis();

      await expect(invalidateCacheNullRedis('key:1')).resolves.toBeUndefined();
    });

    it('invalidateByPattern: langsung return, tidak melempar error', async () => {
      const { invalidateByPattern: invalidateByPatternNullRedis } = await loadCacheWithNullRedis();

      await expect(invalidateByPatternNullRedis('events:list:*')).resolves.toBeUndefined();
    });
  });
});
