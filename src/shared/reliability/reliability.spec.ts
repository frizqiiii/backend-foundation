import { withTimeout, TimeoutError } from './timeout';
import { withRetry } from './retry';
import { withCircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { withBulkhead, BulkheadRejectedError } from './bulkhead';
import { logger } from '../logger';

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockedLogger = logger as jest.Mocked<typeof logger>;

describe('withTimeout', () => {
  it('mengembalikan hasil fn kalau selesai sebelum batas waktu', async () => {
    const result = await withTimeout(async () => 'ok', 1000, 'test');
    expect(result).toBe('ok');
  });

  it('melempar TimeoutError kalau fn tidak selesai sebelum batas waktu', async () => {
    const hangingFn = (signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });

    await expect(withTimeout(hangingFn, 10, 'test')).rejects.toThrow(TimeoutError);
  });

  it('meneruskan error asli kalau fn gagal BUKAN karena timeout', async () => {
    await expect(
      withTimeout(
        async () => {
          throw new Error('gagal biasa');
        },
        1000,
        'test'
      )
    ).rejects.toThrow('gagal biasa');
  });
});

describe('withRetry', () => {
  it('tidak retry kalau percobaan pertama berhasil', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 1 }, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retry sampai berhasil dalam batas attempts', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('gagal 1'))
      .mockRejectedValueOnce(new Error('gagal 2'))
      .mockResolvedValue('ok akhirnya');

    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 1 }, 'test');
    expect(result).toBe('ok akhirnya');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('melempar error asli setelah attempts habis', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('selalu gagal'));
    await expect(withRetry(fn, { attempts: 2, baseDelayMs: 1 }, 'test')).rejects.toThrow(
      'selalu gagal'
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('TIDAK retry kalau isRetryable mengembalikan false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('tidak boleh diulang'));
    await expect(
      withRetry(fn, { attempts: 5, baseDelayMs: 1, isRetryable: () => false }, 'test')
    ).rejects.toThrow('tidak boleh diulang');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withCircuitBreaker', () => {
  const options = { failureThreshold: 3, resetTimeoutMs: 1000 };

  it('meneruskan hasil fn selagi masih CLOSED', async () => {
    const result = await withCircuitBreaker('test-key-1', async () => 'ok', options);
    expect(result).toBe('ok');
  });

  it('terbuka (menolak tanpa memanggil fn) setelah failureThreshold kegagalan beruntun', async () => {
    const key = 'test-key-2';
    const failingFn = jest.fn().mockRejectedValue(new Error('down'));

    for (let i = 0; i < options.failureThreshold; i++) {
      await expect(withCircuitBreaker(key, failingFn, options)).rejects.toThrow('down');
    }
    expect(failingFn).toHaveBeenCalledTimes(options.failureThreshold);

    // Kegagalan ke-(threshold+1) — breaker SUDAH terbuka, fn TIDAK
    // dipanggil sama sekali lagi.
    await expect(withCircuitBreaker(key, failingFn, options)).rejects.toThrow(CircuitOpenError);
    expect(failingFn).toHaveBeenCalledTimes(options.failureThreshold);
  });

  it('kembali ke CLOSED (reset counter) setelah satu panggilan berhasil', async () => {
    const key = 'test-key-3';
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('gagal 1'))
      .mockRejectedValueOnce(new Error('gagal 2'))
      .mockResolvedValueOnce('pulih')
      .mockRejectedValueOnce(new Error('gagal lagi'))
      .mockRejectedValueOnce(new Error('gagal lagi 2'));

    await expect(withCircuitBreaker(key, fn, options)).rejects.toThrow('gagal 1');
    await expect(withCircuitBreaker(key, fn, options)).rejects.toThrow('gagal 2');
    await expect(withCircuitBreaker(key, fn, options)).resolves.toBe('pulih');

    // Counter sudah direset — 2 kegagalan berikutnya BELUM mencapai
    // threshold (3), breaker masih CLOSED, fn tetap dipanggil.
    await expect(withCircuitBreaker(key, fn, options)).rejects.toThrow('gagal lagi');
    await expect(withCircuitBreaker(key, fn, options)).rejects.toThrow('gagal lagi 2');
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('P5 — CircuitOpenError.message memuat key PERSIS (bukan cuma instance-nya)', async () => {
    const key = 'test-key-message';
    const failingFn = jest.fn().mockRejectedValue(new Error('down'));

    for (let i = 0; i < options.failureThreshold; i++) {
      await expect(withCircuitBreaker(key, failingFn, options)).rejects.toThrow('down');
    }

    await expect(withCircuitBreaker(key, failingFn, options)).rejects.toThrow(
      `Circuit breaker '${key}' terbuka — provider dianggap sedang down, request ditolak tanpa mencoba`
    );
  });

  it('P5 — logger.error dipanggil dengan pesan & jumlah kegagalan PERSIS saat breaker terbuka', async () => {
    const key = 'test-key-log-error';
    const failingFn = jest.fn().mockRejectedValue(new Error('down'));

    for (let i = 0; i < options.failureThreshold; i++) {
      await expect(withCircuitBreaker(key, failingFn, options)).rejects.toThrow('down');
    }

    expect(mockedLogger.error).toHaveBeenCalledWith(
      { key, consecutiveFailures: options.failureThreshold },
      `CircuitBreaker '${key}': terbuka setelah ${options.failureThreshold} kegagalan beruntun`
    );
  });

  it('P5 — logger.info "pulih" dipanggil HANYA saat recovery dari state BUKAN CLOSED (bukan setiap kali sukses biasa)', async () => {
    const recoveredKey = 'test-key-log-info-recovery';
    const alwaysOkKey = 'test-key-log-info-always-ok';

    // Kasus recovery: gagal dulu (state jadi bukan CLOSED secara
    // logis lewat consecutiveFailures), TAPI breaker baru benar-benar
    // "terbuka" (state != CLOSED) lewat jalur HALF_OPEN — jadi kita
    // buka penuh breaker-nya dulu, lewati timeout, baru sukses.
    const fn = jest.fn().mockRejectedValue(new Error('down'));
    for (let i = 0; i < options.failureThreshold; i++) {
      await expect(withCircuitBreaker(recoveredKey, fn, options)).rejects.toThrow('down');
    }
    jest.useFakeTimers();
    jest.advanceTimersByTime(options.resetTimeoutMs + 1);
    fn.mockResolvedValueOnce('pulih');
    await expect(withCircuitBreaker(recoveredKey, fn, options)).resolves.toBe('pulih');
    jest.useRealTimers();

    expect(mockedLogger.info).toHaveBeenCalledWith(
      { key: recoveredKey },
      `CircuitBreaker '${recoveredKey}': pulih, kembali ke CLOSED`
    );

    // Kasus TIDAK pernah gagal (selalu CLOSED) — logger.info TIDAK
    // BOLEH dipanggil sama sekali untuk key ini, walau fn berhasil.
    // Menutup mutant yang menghapus kondisi `if (breaker.state !==
    // 'CLOSED')` (over-logging kalau kondisi ini dihapus).
    await withCircuitBreaker(alwaysOkKey, async () => 'ok', options);
    expect(mockedLogger.info).not.toHaveBeenCalledWith(
      { key: alwaysOkKey },
      expect.stringContaining('pulih')
    );
  });

  it('P5 — probe HALF_OPEN GAGAL: breaker kembali OPEN (bukan tetap HALF_OPEN/CLOSED), openedAt di-reset, request BERIKUTNYA langsung ditolak lagi tanpa menunggu resetTimeoutMs lagi', async () => {
    const key = 'test-key-half-open-fails';
    const fn = jest.fn().mockRejectedValue(new Error('down'));

    // Buka breaker.
    for (let i = 0; i < options.failureThreshold; i++) {
      await expect(withCircuitBreaker(key, fn, options)).rejects.toThrow('down');
    }

    jest.useFakeTimers();
    jest.advanceTimersByTime(options.resetTimeoutMs + 1);

    // Probe HALF_OPEN ini GAGAL LAGI (provider belum benar-benar pulih).
    await expect(withCircuitBreaker(key, fn, options)).rejects.toThrow('down');

    // Breaker HARUS kembali OPEN sekarang — panggilan BERIKUTNYA,
    // SEBELUM `resetTimeoutMs` berikutnya lewat, harus ditolak sebagai
    // CircuitOpenError (BUKAN diizinkan lewat sebagai probe lagi, dan
    // BUKAN pula error 'down' dari fn — itu berarti fn tidak
    // dipanggil sama sekali, sesuai desain OPEN).
    fn.mockClear();
    await expect(withCircuitBreaker(key, fn, options)).rejects.toThrow(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('P4 — HANYA satu probe HALF_OPEN yang boleh berjalan; pemanggil concurrent lain ditolak, bukan ikut lolos', async () => {
    const key = 'test-key-4';
    const failingFn = jest.fn().mockRejectedValue(new Error('down'));

    // Buka breaker dulu.
    for (let i = 0; i < options.failureThreshold; i++) {
      await expect(withCircuitBreaker(key, failingFn, options)).rejects.toThrow('down');
    }

    // Lewati resetTimeoutMs supaya breaker siap masuk HALF_OPEN.
    jest.useFakeTimers();
    jest.advanceTimersByTime(options.resetTimeoutMs + 1);

    let releaseProbe: (() => void) | undefined;
    const slowProbeFn = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseProbe = () => resolve('pulih');
        })
    );

    // Dua pemanggil "bersamaan" — panggilan pertama jadi probe,
    // panggilan kedua HARUS langsung ditolak (bukan ikut memanggil
    // slowProbeFn) selama probe pertama belum selesai.
    const first = withCircuitBreaker(key, slowProbeFn, options);
    const second = withCircuitBreaker(key, slowProbeFn, options);

    await expect(second).rejects.toThrow(CircuitOpenError);
    expect(slowProbeFn).toHaveBeenCalledTimes(1);

    releaseProbe?.();
    await expect(first).resolves.toBe('pulih');
    jest.useRealTimers();
  });
});

describe('withBulkhead', () => {
  it('mengizinkan pemanggilan sampai batas maxConcurrent tanpa antre', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const results = await Promise.all([
      withBulkhead('test-bh-1', fn, { maxConcurrent: 2, maxQueue: 1 }),
      withBulkhead('test-bh-1', fn, { maxConcurrent: 2, maxQueue: 1 }),
    ]);
    expect(results).toEqual(['ok', 'ok']);
  });

  it('menolak dengan BulkheadRejectedError kalau maxConcurrent DAN maxQueue penuh', async () => {
    const key = 'test-bh-2';
    let releaseSlow: () => void = () => {};
    const slowFn = () =>
      new Promise<string>((resolve) => {
        releaseSlow = () => resolve('slow-done');
      });

    // Isi maxConcurrent (1) — panggilan ini akan menggantung sampai `releaseSlow()` dipanggil.
    const occupying = withBulkhead(key, slowFn, { maxConcurrent: 1, maxQueue: 0 });

    // maxQueue: 0 — panggilan berikutnya LANGSUNG ditolak, tidak ada slot antrian sama sekali.
    await expect(
      withBulkhead(key, async () => 'ok', { maxConcurrent: 1, maxQueue: 0 })
    ).rejects.toThrow(BulkheadRejectedError);

    releaseSlow();
    await expect(occupying).resolves.toBe('slow-done');
  });

  it('P5 — panggilan yang melebihi maxConcurrent (tapi masih di dalam maxQueue) MENUNGGU, lalu berjalan begitu slot kosong — bukan langsung ditolak', async () => {
    const key = 'test-bh-3';
    let releaseSlow: () => void = () => {};
    const slowFn = () =>
      new Promise<string>((resolve) => {
        releaseSlow = () => resolve('slow-done');
      });
    const fastFn = jest.fn().mockResolvedValue('fast-done');

    // Isi maxConcurrent (1).
    const occupying = withBulkhead(key, slowFn, { maxConcurrent: 1, maxQueue: 1 });

    // maxQueue: 1 — panggilan ini MASUK ANTRIAN (nunggu), bukan ditolak.
    const waiting = withBulkhead(key, fastFn, { maxConcurrent: 1, maxQueue: 1 });

    // fastFn belum sempat berjalan sama sekali selagi slot masih penuh.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fastFn).not.toHaveBeenCalled();

    releaseSlow();
    await expect(occupying).resolves.toBe('slow-done');
    await expect(waiting).resolves.toBe('fast-done');
    expect(fastFn).toHaveBeenCalledTimes(1);
  });
});
