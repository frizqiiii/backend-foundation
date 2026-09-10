import type { Application } from 'express';

describe('mountQueueDashboard', () => {
  const loggerInfo = jest.fn();
  const appUse = jest.fn();
  const createBullBoard = jest.fn();
  const setBasePath = jest.fn();
  const getRouter = jest.fn().mockReturnValue('router-handler');
  const basicAuthMiddleware = jest.fn();
  const basicAuth = jest.fn().mockReturnValue(basicAuthMiddleware);

  async function loadModule(options: {
    queues: {
      email: unknown;
      notification: unknown;
      deadLetter: unknown;
      webhookDelivery: unknown;
      export_: unknown;
    };
    dashboardUser?: string;
    dashboardPassword?: string;
  }) {
    let mod: typeof import('./dashboard') | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('./email.queue', () => ({ emailQueue: options.queues.email }));
      jest.doMock('./notification.queue', () => ({
        notificationQueue: options.queues.notification,
      }));
      jest.doMock('./dead-letter.queue', () => ({ deadLetterQueue: options.queues.deadLetter }));
      jest.doMock('./webhook-delivery.queue', () => ({
        webhookDeliveryQueue: options.queues.webhookDelivery,
      }));
      jest.doMock('./export.queue', () => ({ exportQueue: options.queues.export_ }));
      jest.doMock('../config/env', () => ({
        env: {
          QUEUE_DASHBOARD_USER: options.dashboardUser,
          QUEUE_DASHBOARD_PASSWORD: options.dashboardPassword,
        },
      }));
      jest.doMock('../logger', () => ({ logger: { info: loggerInfo } }));
      jest.doMock('@bull-board/api', () => ({ createBullBoard }));
      jest.doMock('@bull-board/api/bullMQAdapter', () => ({
        BullMQAdapter: jest.fn().mockImplementation((q) => ({ queue: q })),
      }));
      jest.doMock('@bull-board/express', () => ({
        ExpressAdapter: jest.fn().mockImplementation(() => ({
          setBasePath,
          getRouter,
        })),
      }));
      jest.doMock('express-basic-auth', () => basicAuth);

      mod = require('./dashboard');
    });
    return mod!;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const nullQueues = {
    email: null,
    notification: null,
    deadLetter: null,
    webhookDelivery: null,
    export_: null,
  };

  it('TIDAK memasang dashboard kalau SEMUA queue null (Redis tidak dikonfigurasi)', async () => {
    const { mountQueueDashboard } = await loadModule({ queues: nullQueues });
    const app = { use: appUse } as unknown as Application;

    mountQueueDashboard(app);

    expect(appUse).not.toHaveBeenCalled();
    expect(createBullBoard).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('REDIS_URL tidak dikonfigurasi')
    );
  });

  it('TIDAK memasang dashboard kalau queue ada TAPI kredensial dashboard belum diisi', async () => {
    const { mountQueueDashboard } = await loadModule({
      queues: { ...nullQueues, email: {} },
      dashboardUser: undefined,
      dashboardPassword: undefined,
    });
    const app = { use: appUse } as unknown as Application;

    mountQueueDashboard(app);

    expect(appUse).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('QUEUE_DASHBOARD_USER/QUEUE_DASHBOARD_PASSWORD belum dikonfigurasi')
    );
  });

  it('memasang dashboard di /admin/queues dengan basic auth kalau semua syarat terpenuhi', async () => {
    const { mountQueueDashboard } = await loadModule({
      queues: { ...nullQueues, email: {}, webhookDelivery: {}, export_: {} },
      dashboardUser: 'admin',
      dashboardPassword: 'secret',
    });
    const app = { use: appUse } as unknown as Application;

    mountQueueDashboard(app);

    expect(setBasePath).toHaveBeenCalledWith('/admin/queues');
    expect(createBullBoard).toHaveBeenCalledWith(
      expect.objectContaining({ queues: expect.arrayContaining([expect.anything()]) })
    );
    expect(basicAuth).toHaveBeenCalledWith({
      users: { admin: 'secret' },
      challenge: true,
    });
    expect(appUse).toHaveBeenCalledWith('/admin/queues', basicAuthMiddleware, 'router-handler');
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('terpasang di /admin/queues'));
  });

  it('P5 — hanya queue yang tidak null yang ikut didaftarkan ke BullMQAdapter (queue null di-filter keluar)', async () => {
    const { mountQueueDashboard } = await loadModule({
      queues: { ...nullQueues, email: {}, notification: null },
      dashboardUser: 'admin',
      dashboardPassword: 'secret',
    });
    const app = { use: appUse } as unknown as Application;

    mountQueueDashboard(app);

    const [{ queues }] = createBullBoard.mock.calls[0];
    expect(queues).toHaveLength(1);
  });
});
