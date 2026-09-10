import { acquireLock, releaseLock, withLock } from './distributed-lock';
import { redisClient } from '../config/redis';

jest.mock('../config/redis', () => ({
  redisClient: {
    set: jest.fn(),
    eval: jest.fn(),
  },
}));

const mockedRedis = redisClient as jest.Mocked<NonNullable<typeof redisClient>>;

describe('distributed-lock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('acquireLock', () => {
    it('mengembalikan acquired:true dengan token ketika SET NX berhasil', async () => {
      mockedRedis.set.mockResolvedValue('OK');

      const result = await acquireLock('job:cleanup', 5000);

      expect(result.acquired).toBe(true);
      expect(result.token).toEqual(expect.any(String));
      expect(mockedRedis.set).toHaveBeenCalledWith(
        'lock:job:cleanup',
        result.token,
        'PX',
        5000,
        'NX'
      );
    });

    it('mengembalikan acquired:false ketika lock sudah dipegang (SET NX gagal, Redis balas null)', async () => {
      mockedRedis.set.mockResolvedValue(null);

      const result = await acquireLock('job:cleanup', 5000);

      expect(result.acquired).toBe(false);
      expect(result.token).toBeUndefined();
    });

    it('fail-open (acquired:true) kalau Redis error', async () => {
      mockedRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await acquireLock('job:cleanup', 5000);

      expect(result.acquired).toBe(true);
    });
  });

  describe('releaseLock', () => {
    it('memanggil Lua compare-and-delete dengan key & token yang benar', async () => {
      mockedRedis.eval.mockResolvedValue(1);

      await releaseLock('job:cleanup', 'token-abc');

      expect(mockedRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'lock:job:cleanup',
        'token-abc'
      );
    });

    it('tidak memanggil Redis sama sekali untuk token fallback (no-redis/redis-error)', async () => {
      await releaseLock('job:cleanup', 'no-redis-fallback');
      await releaseLock('job:cleanup', 'redis-error-fallback');

      expect(mockedRedis.eval).not.toHaveBeenCalled();
    });

    it('tidak melempar error kalau Redis gagal saat release', async () => {
      mockedRedis.eval.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(releaseLock('job:cleanup', 'token-abc')).resolves.toBeUndefined();
    });
  });

  describe('withLock', () => {
    it('menjalankan fn dan melepaskan lock setelah selesai ketika lock berhasil diambil', async () => {
      mockedRedis.set.mockResolvedValue('OK');
      mockedRedis.eval.mockResolvedValue(1);
      const fn = jest.fn().mockResolvedValue('done');

      const result = await withLock('job:cleanup', 5000, fn);

      expect(result).toEqual({ ran: true, result: 'done' });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(mockedRedis.eval).toHaveBeenCalledTimes(1);
    });

    it('mengembalikan ran:false TANPA memanggil fn kalau lock sedang dipegang proses lain', async () => {
      mockedRedis.set.mockResolvedValue(null);
      const fn = jest.fn();

      const result = await withLock('job:cleanup', 5000, fn);

      expect(result).toEqual({ ran: false });
      expect(fn).not.toHaveBeenCalled();
    });

    it('TETAP melepaskan lock meski fn melempar error', async () => {
      mockedRedis.set.mockResolvedValue('OK');
      mockedRedis.eval.mockResolvedValue(1);
      const fn = jest.fn().mockRejectedValue(new Error('job gagal'));

      await expect(withLock('job:cleanup', 5000, fn)).rejects.toThrow('job gagal');
      expect(mockedRedis.eval).toHaveBeenCalledTimes(1);
    });
  });
});
