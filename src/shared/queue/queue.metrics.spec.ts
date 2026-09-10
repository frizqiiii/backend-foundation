import { observeQueueProcessingTime, queueProcessingTimeHistogram } from './queue.metrics';

describe('observeQueueProcessingTime', () => {
  beforeEach(() => {
    queueProcessingTimeHistogram.reset();
  });

  it('mengembalikan hasil `fn` apa adanya dan mencatat observasi dengan status completed', async () => {
    const result = await observeQueueProcessingTime('email', async () => 'ok');

    expect(result).toBe('ok');
    const metric = await queueProcessingTimeHistogram.get();
    const completedSample = metric.values.find(
      (v) =>
        v.metricName === 'queue_processing_time_count' &&
        v.labels.queue === 'email' &&
        v.labels.status === 'completed'
    );
    expect(completedSample?.value).toBe(1);
  });

  it('melempar ulang error dari `fn` APA ADANYA dan tetap mencatat observasi dengan status failed', async () => {
    const boom = new Error('job meledak');

    await expect(
      observeQueueProcessingTime('export', async () => {
        throw boom;
      })
    ).rejects.toThrow(boom);

    const metric = await queueProcessingTimeHistogram.get();
    const failedSample = metric.values.find(
      (v) =>
        v.metricName === 'queue_processing_time_count' &&
        v.labels.queue === 'export' &&
        v.labels.status === 'failed'
    );
    expect(failedSample?.value).toBe(1);
  });
});

describe('queueJobsGauge.collect()', () => {
  async function loadWithQueues(queues: {
    email?: unknown;
    notification?: unknown;
    deadLetter?: unknown;
    webhookDelivery?: unknown;
    export_?: unknown;
  }) {
    let mod: typeof import('./queue.metrics') | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('./email.queue', () => ({ emailQueue: queues.email ?? null }));
      jest.doMock('./notification.queue', () => ({
        notificationQueue: queues.notification ?? null,
      }));
      jest.doMock('./dead-letter.queue', () => ({ deadLetterQueue: queues.deadLetter ?? null }));
      jest.doMock('./webhook-delivery.queue', () => ({
        webhookDeliveryQueue: queues.webhookDelivery ?? null,
      }));
      jest.doMock('./export.queue', () => ({ exportQueue: queues.export_ ?? null }));
      mod = require('./queue.metrics');
    });
    return mod!;
  }

  it('mengisi gauge per queue+status dari getJobCounts(), melewati queue yang null', async () => {
    const getJobCounts = jest.fn().mockResolvedValue({
      waiting: 3,
      active: 1,
      delayed: 0,
      completed: 10,
      failed: 2,
    });
    const { queueJobsGauge } = await loadWithQueues({ email: { getJobCounts } });

    const metric = await queueJobsGauge.get();

    expect(getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed'
    );
    const waitingSample = metric.values.find(
      (v) => v.labels.queue === 'email' && v.labels.status === 'waiting'
    );
    expect(waitingSample?.value).toBe(3);
  });

  it('P5 — kegagalan getJobCounts pada satu queue di-log dan TIDAK menggagalkan scrape queue lain', async () => {
    const failingGetJobCounts = jest.fn().mockRejectedValue(new Error('Redis timeout'));
    const workingGetJobCounts = jest.fn().mockResolvedValue({
      waiting: 1,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });
    const { queueJobsGauge } = await loadWithQueues({
      email: { getJobCounts: failingGetJobCounts },
      notification: { getJobCounts: workingGetJobCounts },
    });

    await expect(queueJobsGauge.get()).resolves.toBeDefined();
    expect(workingGetJobCounts).toHaveBeenCalled();
  });
});

describe('workerHealthGauge.collect()', () => {
  async function loadWithConnection(connection: unknown) {
    let mod: typeof import('./queue.metrics') | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('./connection', () => ({ queueConnection: connection }));
      jest.doMock('./email.queue', () => ({ emailQueue: null }));
      jest.doMock('./notification.queue', () => ({ notificationQueue: null }));
      jest.doMock('./dead-letter.queue', () => ({ deadLetterQueue: null }));
      jest.doMock('./webhook-delivery.queue', () => ({ webhookDeliveryQueue: null }));
      jest.doMock('./export.queue', () => ({ exportQueue: null }));
      mod = require('./queue.metrics');
    });
    return mod!;
  }

  it('P5 — tidak melakukan apa pun kalau queueConnection null (Redis tidak dikonfigurasi)', async () => {
    const { workerHealthGauge } = await loadWithConnection(null);

    await expect(workerHealthGauge.get()).resolves.toBeDefined();
  });

  it('menandai worker hidup (1) kalau heartbeat masih baru, mati (0) kalau heartbeat lama/tidak ada', async () => {
    const get = jest.fn().mockImplementation((key: string) => {
      if (key === 'worker:heartbeat:email') return Promise.resolve(String(Date.now()));
      if (key === 'worker:heartbeat:notification') {
        return Promise.resolve(String(Date.now() - 60_000));
      }
      return Promise.resolve(null);
    });
    const { workerHealthGauge } = await loadWithConnection({ get });

    const metric = await workerHealthGauge.get();

    const emailSample = metric.values.find((v) => v.labels.queue === 'email');
    const notificationSample = metric.values.find((v) => v.labels.queue === 'notification');
    const webhookSample = metric.values.find((v) => v.labels.queue === 'webhook-delivery');
    expect(emailSample?.value).toBe(1);
    expect(notificationSample?.value).toBe(0);
    expect(webhookSample?.value).toBe(0);
  });

  it('P5 — kegagalan membaca heartbeat satu worker di-log dan TIDAK menggagalkan worker lain', async () => {
    const get = jest.fn().mockRejectedValue(new Error('Redis timeout'));
    const { workerHealthGauge } = await loadWithConnection({ get });

    await expect(workerHealthGauge.get()).resolves.toBeDefined();
  });
});

describe('sendWorkerHeartbeat', () => {
  async function loadWithConnectionForHeartbeat(connection: unknown) {
    let mod: typeof import('./queue.metrics') | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('./connection', () => ({ queueConnection: connection }));
      mod = require('./queue.metrics');
    });
    return mod!;
  }

  it('menulis timestamp saat ini ke Redis dengan key worker:heartbeat:<queue>', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    const { sendWorkerHeartbeat } = await loadWithConnectionForHeartbeat({ set });

    await sendWorkerHeartbeat('email');

    expect(set).toHaveBeenCalledWith('worker:heartbeat:email', expect.any(String));
  });

  it('P5 — tidak melakukan apa pun kalau queueConnection null', async () => {
    const { sendWorkerHeartbeat } = await loadWithConnectionForHeartbeat(null);

    await expect(sendWorkerHeartbeat('email')).resolves.toBeUndefined();
  });

  it('P5 — kegagalan menulis heartbeat di-log, tidak melempar error', async () => {
    const set = jest.fn().mockRejectedValue(new Error('Redis timeout'));
    const { sendWorkerHeartbeat } = await loadWithConnectionForHeartbeat({ set });

    await expect(sendWorkerHeartbeat('email')).resolves.toBeUndefined();
  });
});
