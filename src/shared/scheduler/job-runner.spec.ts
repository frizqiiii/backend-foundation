import { runJobWithRetry } from './job-runner';
import type { ScheduledJobDefinition } from './scheduler.types';

/**
 * `setTimeout` di-mock supaya backoff antar-retry (2s/4s/8s di
 * implementasi asli) tidak benar-benar membuat test menunggu — test
 * ini fokus menguji PERILAKU retry (berapa kali `run()` dipanggil,
 * kapan berhenti), bukan durasi asli backoff-nya.
 */
jest.useFakeTimers();

function createJob(overrides: Partial<ScheduledJobDefinition> = {}): ScheduledJobDefinition {
  return {
    name: 'dummy-job',
    cronExpression: '0 0 * * *',
    run: jest.fn().mockResolvedValue({ message: 'sukses' }),
    ...overrides,
  };
}

describe('runJobWithRetry', () => {
  it('memanggil run() hanya SEKALI ketika langsung berhasil di percobaan pertama', async () => {
    const job = createJob();

    await runJobWithRetry(job);

    expect(job.run).toHaveBeenCalledTimes(1);
  });

  it('mencoba ulang sampai berhasil, TIDAK melebihi jumlah percobaan yang diperlukan', async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error('DB sedang restart'))
      .mockResolvedValueOnce({ message: 'sukses di percobaan kedua' });
    const job = createJob({ run });

    const promise = runJobWithRetry(job);
    await jest.runAllTimersAsync();
    await promise;

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('berhenti mencoba setelah 3 percobaan gagal berturut-turut, TIDAK melempar error ke pemanggil', async () => {
    const run = jest.fn().mockRejectedValue(new Error('Koneksi database gagal terus-menerus'));
    const job = createJob({ run });

    const promise = runJobWithRetry(job);
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(3);
  });

  it('TIDAK memanggil run() sama sekali kalau instance lain sedang memegang lock job ini', async () => {
    jest.resetModules();
    jest.doMock('../config/redis', () => ({
      redisClient: { set: jest.fn().mockResolvedValue(null), eval: jest.fn() },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runJobWithRetry: runWithLockedRedis } = require('./job-runner');

    const job = createJob();
    await runWithLockedRedis(job);

    expect(job.run).not.toHaveBeenCalled();

    jest.dontMock('../config/redis');
    jest.resetModules();
  });
});
