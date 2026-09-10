import { checkAccountLock, recordFailedAttempt, resetAttempts } from './login-attempt-tracker';

/**
 * `REDIS_URL` kosong di `jest.setup.ts` (lihat env stub test) —
 * `redisClient` bernilai `null`, jadi seluruh test di sini otomatis
 * menguji jalur FALLBACK in-memory, bukan Redis. Itu jalur yang
 * relevan untuk unit test murni (tanpa Redis sungguhan berjalan);
 * jalur Redis sendiri hanya beda pada API client yang dipanggil
 * (`incr`/`expire`/`ttl`/`set`/`del`), bukan pada aturan bisnisnya.
 */
describe('login-attempt-tracker (in-memory fallback)', () => {
  const email = `user-${Date.now()}@example.com`; // unik per test run agar tidak bentrok antar test

  it('akun tidak terkunci sebelum ada percobaan gagal sama sekali', async () => {
    const status = await checkAccountLock(email);
    expect(status.locked).toBe(false);
  });

  it('akun TETAP tidak terkunci setelah kegagalan di bawah ambang batas (4 dari 5)', async () => {
    const testEmail = `below-threshold-${Date.now()}@example.com`;

    for (let i = 0; i < 4; i += 1) {
      await recordFailedAttempt(testEmail);
    }

    const status = await checkAccountLock(testEmail);
    expect(status.locked).toBe(false);
  });

  it('akun TERKUNCI setelah 5 kegagalan berturut-turut, dengan sisa waktu kunci > 0', async () => {
    const testEmail = `at-threshold-${Date.now()}@example.com`;

    for (let i = 0; i < 5; i += 1) {
      await recordFailedAttempt(testEmail);
    }

    const status = await checkAccountLock(testEmail);
    expect(status.locked).toBe(true);
    expect(status.remainingSeconds).toBeGreaterThan(0);
  });

  it('resetAttempts membuka kembali akun yang terkunci', async () => {
    const testEmail = `reset-${Date.now()}@example.com`;

    for (let i = 0; i < 5; i += 1) {
      await recordFailedAttempt(testEmail);
    }
    expect((await checkAccountLock(testEmail)).locked).toBe(true);

    await resetAttempts(testEmail);

    expect((await checkAccountLock(testEmail)).locked).toBe(false);
  });

  it('identifier dinormalisasi (case-insensitive, di-trim) — "Budi@Example.com " dan "budi@example.com" dianggap akun yang sama', async () => {
    const base = `Case-${Date.now()}@Example.com`;

    for (let i = 0; i < 5; i += 1) {
      await recordFailedAttempt(` ${base.toUpperCase()} `);
    }

    const status = await checkAccountLock(base.toLowerCase());
    expect(status.locked).toBe(true);
  });

  it('P5 — lock in-memory yang SUDAH KEDALUWARSA dibersihkan (dihapus dari Map) saat dicek ulang, bukan cuma diabaikan', async () => {
    const testEmail = `expired-lock-${Date.now()}@example.com`;
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 5; i += 1) {
        await recordFailedAttempt(testEmail);
      }
      expect((await checkAccountLock(testEmail)).locked).toBe(true);

      // Lewati 15 menit + 1 detik (LOCK_DURATION_SECONDS) — lock jadi kedaluwarsa.
      jest.advanceTimersByTime(15 * 60 * 1000 + 1000);

      const status = await checkAccountLock(testEmail);
      expect(status.locked).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('login-attempt-tracker (jalur Redis)', () => {
  async function loadWithRedis(redisClient: unknown) {
    let mod: typeof import('./login-attempt-tracker') | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../config/redis', () => ({ redisClient }));
      jest.doMock('../logger', () => ({ logger: { warn: jest.fn() } }));
      mod = require('./login-attempt-tracker');
    });
    return mod!;
  }

  describe('checkAccountLock', () => {
    it('locked:true kalau TTL lock key > 0', async () => {
      const redisClient = { ttl: jest.fn().mockResolvedValue(120) };
      const { checkAccountLock } = await loadWithRedis(redisClient);

      const status = await checkAccountLock('budi@example.com');

      expect(redisClient.ttl).toHaveBeenCalledWith('login_lock:budi@example.com');
      expect(status).toEqual({ locked: true, remainingSeconds: 120 });
    });

    it('locked:false kalau TTL <= 0 (key tidak ada/tidak dikunci)', async () => {
      const redisClient = { ttl: jest.fn().mockResolvedValue(-2) };
      const { checkAccountLock } = await loadWithRedis(redisClient);

      const status = await checkAccountLock('budi@example.com');

      expect(status).toEqual({ locked: false });
    });

    it('P5 — fail-open (locked:false) kalau Redis error saat baca TTL', async () => {
      const redisClient = { ttl: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
      const { checkAccountLock } = await loadWithRedis(redisClient);

      const status = await checkAccountLock('budi@example.com');

      expect(status).toEqual({ locked: false });
    });
  });

  describe('recordFailedAttempt', () => {
    it('increment lalu set TTL jendela HANYA pada percobaan PERTAMA (count === 1)', async () => {
      const redisClient = {
        incr: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
        set: jest.fn(),
      };
      const { recordFailedAttempt } = await loadWithRedis(redisClient);

      await recordFailedAttempt('budi@example.com');

      expect(redisClient.expire).toHaveBeenCalledWith('login_attempts:budi@example.com', 900);
      expect(redisClient.set).not.toHaveBeenCalled();
    });

    it('P5 — TIDAK mengatur ulang TTL jendela pada percobaan kedua dst (count > 1)', async () => {
      const redisClient = {
        incr: jest.fn().mockResolvedValue(2),
        expire: jest.fn(),
        set: jest.fn(),
      };
      const { recordFailedAttempt } = await loadWithRedis(redisClient);

      await recordFailedAttempt('budi@example.com');

      expect(redisClient.expire).not.toHaveBeenCalled();
    });

    it('mengunci akun (SET lock key dengan TTL) begitu mencapai ambang batas', async () => {
      const redisClient = {
        incr: jest.fn().mockResolvedValue(5),
        expire: jest.fn(),
        set: jest.fn().mockResolvedValue('OK'),
      };
      const { recordFailedAttempt } = await loadWithRedis(redisClient);

      await recordFailedAttempt('budi@example.com');

      expect(redisClient.set).toHaveBeenCalledWith('login_lock:budi@example.com', '1', 'EX', 900);
    });

    it('P5 — fail-silent kalau Redis error saat mencatat percobaan (tidak melempar)', async () => {
      const redisClient = { incr: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
      const { recordFailedAttempt } = await loadWithRedis(redisClient);

      await expect(recordFailedAttempt('budi@example.com')).resolves.toBeUndefined();
    });
  });

  describe('resetAttempts', () => {
    it('menghapus KEDUA key (attempts dan lock) sekaligus', async () => {
      const redisClient = { del: jest.fn().mockResolvedValue(2) };
      const { resetAttempts } = await loadWithRedis(redisClient);

      await resetAttempts('budi@example.com');

      expect(redisClient.del).toHaveBeenCalledWith(
        'login_attempts:budi@example.com',
        'login_lock:budi@example.com'
      );
    });

    it('P5 — fail-silent kalau Redis error saat reset (tidak melempar)', async () => {
      const redisClient = { del: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
      const { resetAttempts } = await loadWithRedis(redisClient);

      await expect(resetAttempts('budi@example.com')).resolves.toBeUndefined();
    });
  });
});
