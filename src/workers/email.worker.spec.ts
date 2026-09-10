/**
 * Strategi test: `emailWorker` bernilai `null` di lingkungan test biasa
 * (REDIS_URL='' di jest.setup.ts -> queueConnection null -> `new
 * Worker(...)` TIDAK PERNAH dipanggil, lihat email.worker.ts). Supaya
 * bisa menguji processor function DAN event handler 'completed'/
 * 'failed' yang didaftarkan di dalamnya, modul ini di-require ULANG
 * secara terisolasi (`jest.isolateModulesAsync`) dengan `queueConnection`
 * di-mock jadi truthy dan `bullmq`'s `Worker` di-mock supaya
 * mengembalikan objek palsu yang MENYIMPAN processor + handler yang
 * diteruskan ke constructor-nya — bukan benar-benar konek ke Redis.
 */
import type { EmailJobData } from '../shared/queue/email.queue';

describe('email.worker', () => {
  const processEmailJob = jest.fn();
  const moveToDeadLetter = jest.fn();
  const observeQueueProcessingTime = jest.fn((_queue: string, fn: () => Promise<unknown>) => fn());
  const loggerInfo = jest.fn();
  const loggerError = jest.fn();
  let capturedProcessor: ((job: { data: EmailJobData }) => Promise<void>) | undefined;
  let capturedHandlers: Record<string, (...args: unknown[]) => void>;

  async function loadWorkerModule() {
    let mod: typeof import('./email.worker') | undefined;
    await jest.isolateModulesAsync(async () => {
      capturedHandlers = {};
      jest.doMock('bullmq', () => ({
        Worker: jest
          .fn()
          .mockImplementation((_name: string, processor: typeof capturedProcessor) => {
            capturedProcessor = processor;
            return {
              on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
                capturedHandlers[event] = handler;
              }),
            };
          }),
      }));
      jest.doMock('../shared/queue/connection', () => ({ queueConnection: {} }));
      jest.doMock('../shared/queue/email.queue', () => ({ processEmailJob }));
      jest.doMock('../shared/queue/dead-letter.queue', () => ({ moveToDeadLetter }));
      jest.doMock('../shared/queue/queue.metrics', () => ({ observeQueueProcessingTime }));
      jest.doMock('../shared/logger', () => ({
        logger: { info: loggerInfo, error: loggerError },
      }));
      jest.doMock('../shared/observability/bullmq-telemetry', () => ({ bullMQTelemetry: null }));

      mod = require('./email.worker');
    });
    return mod!;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    capturedProcessor = undefined;
  });

  it('emailWorker bernilai null kalau queueConnection null (Redis tidak dikonfigurasi) — perilaku default lingkungan test biasa', async () => {
    // Tanpa mock apa pun (queueConnection asli, REDIS_URL='' di jest.setup.ts).
    const realMod = await import('./email.worker');
    expect(realMod.emailWorker).toBeNull();
  });

  it('processor memanggil processEmailJob(job.data) dibungkus observeQueueProcessingTime("email", ...)', async () => {
    await loadWorkerModule();
    processEmailJob.mockResolvedValue(undefined);
    const jobData: EmailJobData = { type: 'verification', to: 'budi@example.com', token: 'tok' };

    await capturedProcessor!({ data: jobData });

    expect(observeQueueProcessingTime).toHaveBeenCalledWith('email', expect.any(Function));
    expect(processEmailJob).toHaveBeenCalledWith(jobData);
  });

  it('P5 — event "failed": job SUDAH kehabisan seluruh percobaan (attemptsMade >= attempts) -> dipindah ke dead-letter queue', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-1',
      name: 'verification',
      data: { type: 'verification', to: 'budi@example.com', token: 'tok' },
      attemptsMade: 5,
      opts: { attempts: 5 },
    };
    const err = new Error('SMTP timeout');

    capturedHandlers.failed(job, err);
    await new Promise(process.nextTick);

    expect(loggerError).toHaveBeenCalled();
    expect(moveToDeadLetter).toHaveBeenCalledWith({
      queue: 'email',
      jobName: 'verification',
      data: job.data,
      failedReason: 'SMTP timeout',
      attemptsMade: 5,
    });
  });

  it('P5 — event "failed": job MASIH ada sisa percobaan retry -> TIDAK dipindah ke dead-letter queue (BullMQ akan retry otomatis)', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-2',
      name: 'verification',
      data: { type: 'verification', to: 'budi@example.com', token: 'tok' },
      attemptsMade: 2,
      opts: { attempts: 5 },
    };

    capturedHandlers.failed(job, new Error('sementara gagal'));
    await new Promise(process.nextTick);

    expect(moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('P5 — event "failed": job undefined (edge case BullMQ) ditangani tanpa melempar, TIDAK memindah ke dead-letter', async () => {
    await loadWorkerModule();

    expect(() => capturedHandlers.failed(undefined, new Error('unknown'))).not.toThrow();
    expect(moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('P5 — event "failed": job.opts.attempts tidak diisi (fallback default 1) -> attemptsMade:1 SUDAH dianggap kehabisan percobaan', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-4',
      name: 'verification',
      data: { type: 'verification', to: 'budi@example.com', token: 'tok' },
      attemptsMade: 1,
      opts: {},
    };

    capturedHandlers.failed(job, new Error('gagal sekali, tanpa attempts custom'));
    await new Promise(process.nextTick);

    expect(moveToDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'verification', attemptsMade: 1 })
    );
  });

  it('event "completed" mencatat log info dengan id+nama job', async () => {
    await loadWorkerModule();
    const job = { id: 'job-3', name: 'verification' };

    capturedHandlers.completed(job);

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('job-3'));
  });
});
