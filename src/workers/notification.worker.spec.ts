import type { NotificationJobData } from '../shared/queue/notification.queue';

describe('notification.worker', () => {
  const processNotificationJob = jest.fn();
  const moveToDeadLetter = jest.fn();
  const observeQueueProcessingTime = jest.fn((_queue: string, fn: () => Promise<unknown>) => fn());
  const loggerInfo = jest.fn();
  const loggerError = jest.fn();
  let capturedProcessor: ((job: { data: NotificationJobData }) => Promise<void>) | undefined;
  let capturedHandlers: Record<string, (...args: unknown[]) => void>;

  async function loadWorkerModule() {
    let mod: typeof import('./notification.worker') | undefined;
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
      jest.doMock('../shared/queue/notification.queue', () => ({ processNotificationJob }));
      jest.doMock('../shared/queue/dead-letter.queue', () => ({ moveToDeadLetter }));
      jest.doMock('../shared/queue/queue.metrics', () => ({ observeQueueProcessingTime }));
      jest.doMock('../shared/logger', () => ({
        logger: { info: loggerInfo, error: loggerError },
      }));
      jest.doMock('../shared/observability/bullmq-telemetry', () => ({ bullMQTelemetry: null }));

      mod = require('./notification.worker');
    });
    return mod!;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    capturedProcessor = undefined;
  });

  it('notificationWorker bernilai null kalau queueConnection null (perilaku default lingkungan test)', async () => {
    const realMod = await import('./notification.worker');
    expect(realMod.notificationWorker).toBeNull();
  });

  it('processor memanggil processNotificationJob(job.data) dibungkus observeQueueProcessingTime("notification", ...)', async () => {
    await loadWorkerModule();
    processNotificationJob.mockResolvedValue(undefined);
    const jobData = { type: 'in-app', userId: 'user-1', message: 'Halo' } as NotificationJobData;

    await capturedProcessor!({ data: jobData });

    expect(observeQueueProcessingTime).toHaveBeenCalledWith('notification', expect.any(Function));
    expect(processNotificationJob).toHaveBeenCalledWith(jobData);
  });

  it('P5 — event "failed": kehabisan percobaan -> dipindah ke dead-letter queue', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-1',
      name: 'in-app',
      data: { type: 'in-app', userId: 'user-1', message: 'Halo' },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };

    capturedHandlers.failed(job, new Error('gagal kirim'));
    await new Promise(process.nextTick);

    expect(loggerError).toHaveBeenCalled();
    expect(moveToDeadLetter).toHaveBeenCalledWith({
      queue: 'notification',
      jobName: 'in-app',
      data: job.data,
      failedReason: 'gagal kirim',
      attemptsMade: 3,
    });
  });

  it('P5 — event "failed": masih ada sisa percobaan -> TIDAK dipindah ke dead-letter', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-2',
      name: 'in-app',
      data: { type: 'in-app', userId: 'user-1', message: 'Halo' },
      attemptsMade: 1,
      opts: { attempts: 3 },
    };

    capturedHandlers.failed(job, new Error('sementara'));
    await new Promise(process.nextTick);

    expect(moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('P5 — event "failed": job undefined ditangani tanpa melempar', async () => {
    await loadWorkerModule();

    expect(() => capturedHandlers.failed(undefined, new Error('unknown'))).not.toThrow();
    expect(moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('P5 — event "failed": job.opts.attempts tidak diisi (fallback default 1)', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-3',
      name: 'in-app',
      data: { type: 'in-app', userId: 'user-1', message: 'Halo' },
      attemptsMade: 1,
      opts: {},
    };

    capturedHandlers.failed(job, new Error('gagal'));
    await new Promise(process.nextTick);

    expect(moveToDeadLetter).toHaveBeenCalledWith(expect.objectContaining({ attemptsMade: 1 }));
  });

  it('event "completed" mencatat log info dengan id job', async () => {
    await loadWorkerModule();
    capturedHandlers.completed({ id: 'job-4' });

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('job-4'));
  });
});
