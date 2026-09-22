/**
 * Chaos engineering drill (item 2.7) menemukan bug reliability nyata
 * di konfigurasi ini — lihat komentar lengkap di `redis.ts`. Test ini
 * SENGAJA memeriksa NILAI KONFIGURASI-nya secara langsung (bukan cuma
 * "redisClient tidak null"), supaya regresi ke `maxRetriesPerRequest`
 * yang menunggu reconnect atau `retryStrategy` yang membesar seiring
 * waktu ketahuan lewat test biasa — tidak perlu drill chaos manual
 * lagi setiap kali untuk menangkap regresi yang SAMA.
 */
describe('redis.ts — konfigurasi fail-fast (Chaos Engineering, item 2.7)', () => {
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    process.env.REDIS_URL = originalRedisUrl;
  });

  it('maxRetriesPerRequest: 0 — command GAGAL SEKETIKA, tidak pernah menunggu siklus reconnect', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      const { redisClient } = await import('./redis');
      expect(redisClient).not.toBeNull();
      expect(
        (redisClient as { options: { maxRetriesPerRequest: number } }).options.maxRetriesPerRequest
      ).toBe(0);
      await redisClient?.quit().catch(() => {});
    });
  });

  it('retryStrategy: delay KONSTAN — TIDAK membesar seiring banyaknya percobaan reconnect (root cause bug chaos drill)', async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      const { redisClient } = await import('./redis');
      const retryStrategy = (
        redisClient as { options: { retryStrategy: (times: number) => number } }
      ).options.retryStrategy;

      // Diuji di beberapa titik `times` yang JAUH berbeda -- kalau
      // ada yang secara tidak sengaja mengembalikan rumus yang
      // membesar (mis. `times * 200`) lagi, delay di percobaan
      // ke-100 akan jelas beda dari percobaan ke-1, dan test ini gagal.
      const delayAt1 = retryStrategy(1);
      const delayAt10 = retryStrategy(10);
      const delayAt100 = retryStrategy(100);

      expect(delayAt1).toBe(delayAt10);
      expect(delayAt10).toBe(delayAt100);
      // Cukup singkat supaya reconnect di background tetap responsif
      // (lihat chaos drill: delay yang sama dipakai untuk SETIAP
      // command yang kebetulan datang saat reconnect berlangsung).
      expect(delayAt1).toBeLessThanOrEqual(500);

      await redisClient?.quit().catch(() => {});
    });
  });
});

describe('redis.ts — konfigurasi Cluster fail-fast (temuan T21, audit ulang item 2.7)', () => {
  const originalClusterNodes = process.env.REDIS_CLUSTER_NODES;
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    process.env.REDIS_CLUSTER_NODES = originalClusterNodes;
    process.env.REDIS_URL = originalRedisUrl;
  });

  it('maxRetriesPerRequest: 0 di redisOptions — sama seperti mode single-instance', async () => {
    await jest.isolateModulesAsync(async () => {
      delete process.env.REDIS_URL;
      process.env.REDIS_CLUSTER_NODES = '127.0.0.1:7000,127.0.0.1:7001';
      const { redisClient } = await import('./redis');
      expect(redisClient).not.toBeNull();
      const opts = (
        redisClient as unknown as { options: { redisOptions: { maxRetriesPerRequest: number } } }
      ).options.redisOptions;
      expect(opts.maxRetriesPerRequest).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
      redisClient?.disconnect();
    });
  });

  it('clusterRetryStrategy: delay KONSTAN (bukan default ioredis yang retry selamanya tanpa batas eksplisit)', async () => {
    await jest.isolateModulesAsync(async () => {
      delete process.env.REDIS_URL;
      process.env.REDIS_CLUSTER_NODES = '127.0.0.1:7000,127.0.0.1:7001';
      const { redisClient } = await import('./redis');
      const strategy = (
        redisClient as unknown as { options: { clusterRetryStrategy: (times: number) => number } }
      ).options.clusterRetryStrategy;
      expect(strategy(1)).toBe(strategy(50));
      expect(strategy(1)).toBeLessThanOrEqual(500);
      await new Promise((r) => setTimeout(r, 300));
      redisClient?.disconnect();
    });
  });

  it('enableOfflineQueue: false — command SAAT cluster tidak ready ditolak seketika, tidak diantre tanpa batas waktu (akar masalah T21: diuji nyata satu GET hang >15 detik sebelum fix ini)', async () => {
    await jest.isolateModulesAsync(async () => {
      delete process.env.REDIS_URL;
      process.env.REDIS_CLUSTER_NODES = '127.0.0.1:7000,127.0.0.1:7001';
      const { redisClient } = await import('./redis');
      expect(
        (redisClient as unknown as { options: { enableOfflineQueue: boolean } }).options
          .enableOfflineQueue
      ).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      redisClient?.disconnect();
    });
  });
});
