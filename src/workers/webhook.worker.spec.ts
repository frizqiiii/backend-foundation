import type { WebhookDeliveryJobData } from '../shared/queue/webhook-delivery.queue';

describe('webhook.worker', () => {
  const processWebhookDeliveryJob = jest.fn();
  const moveToDeadLetter = jest.fn();
  const observeQueueProcessingTime = jest.fn((_queue: string, fn: () => Promise<unknown>) => fn());
  const loggerInfo = jest.fn();
  const loggerError = jest.fn();
  let capturedProcessor: ((job: { data: WebhookDeliveryJobData }) => Promise<void>) | undefined;
  let capturedHandlers: Record<string, (...args: unknown[]) => void>;

  async function loadWorkerModule() {
    let mod: typeof import('./webhook.worker') | undefined;
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
      jest.doMock('../shared/queue/webhook-delivery.queue', () => ({ processWebhookDeliveryJob }));
      jest.doMock('../shared/queue/dead-letter.queue', () => ({ moveToDeadLetter }));
      jest.doMock('../shared/queue/queue.metrics', () => ({ observeQueueProcessingTime }));
      jest.doMock('../shared/logger', () => ({
        logger: { info: loggerInfo, error: loggerError },
      }));
      jest.doMock('../shared/observability/bullmq-telemetry', () => ({ bullMQTelemetry: null }));

      mod = require('./webhook.worker');
    });
    return mod!;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    capturedProcessor = undefined;
  });

  it('webhookDeliveryWorker bernilai null kalau queueConnection null (perilaku default lingkungan test)', async () => {
    const realMod = await import('./webhook.worker');
    expect(realMod.webhookDeliveryWorker).toBeNull();
  });

  it('processor memanggil processWebhookDeliveryJob(job.data) dibungkus observeQueueProcessingTime', async () => {
    await loadWorkerModule();
    processWebhookDeliveryJob.mockResolvedValue(undefined);
    const jobData = {
      endpointId: 'wh-1',
      url: 'https://example.com/hooks',
      eventType: 'product.created',
      payload: {},
    } as unknown as WebhookDeliveryJobData;

    await capturedProcessor!({ data: jobData });

    expect(observeQueueProcessingTime).toHaveBeenCalledWith(
      'webhook-delivery',
      expect.any(Function)
    );
    expect(processWebhookDeliveryJob).toHaveBeenCalledWith(jobData);
  });

  it('P5 — event "failed": kehabisan percobaan -> dipindah ke dead-letter queue', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-1',
      name: 'product.created',
      data: { endpointId: 'wh-1' },
      attemptsMade: 4,
      opts: { attempts: 4 },
    };

    capturedHandlers.failed(job, new Error('endpoint 500'));
    await new Promise(process.nextTick);

    expect(moveToDeadLetter).toHaveBeenCalledWith({
      queue: 'webhook-delivery',
      jobName: 'product.created',
      data: job.data,
      failedReason: 'endpoint 500',
      attemptsMade: 4,
    });
  });

  it('P5 — event "failed": masih ada sisa percobaan -> TIDAK dipindah ke dead-letter', async () => {
    await loadWorkerModule();
    const job = { id: 'job-2', name: 'x', data: {}, attemptsMade: 1, opts: { attempts: 4 } };

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
    const job = { id: 'job-4', name: 'x', data: {}, attemptsMade: 1, opts: {} };

    capturedHandlers.failed(job, new Error('gagal'));
    await new Promise(process.nextTick);

    expect(moveToDeadLetter).toHaveBeenCalledWith(expect.objectContaining({ attemptsMade: 1 }));
  });

  it('event "completed" mencatat log info dengan id+nama job', async () => {
    await loadWorkerModule();
    capturedHandlers.completed({ id: 'job-3', name: 'product.created' });

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('job-3'));
  });
});
