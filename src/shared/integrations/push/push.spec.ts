describe('push provider factory', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('memilih logPushProvider secara default', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pushProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logPushProvider } = require('./log-push.provider');
    expect(pushProvider).toBe(logPushProvider);
  });

  it('fallback ke log kalau PUSH_PROVIDER=fcm tapi FCM_SERVER_KEY kosong', () => {
    process.env.PUSH_PROVIDER = 'fcm';
    process.env.FCM_SERVER_KEY = '';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pushProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logPushProvider } = require('./log-push.provider');
    expect(pushProvider).toBe(logPushProvider);
    delete process.env.PUSH_PROVIDER;
  });

  it('memilih fcmPushProvider kalau FCM_SERVER_KEY terisi', () => {
    process.env.PUSH_PROVIDER = 'fcm';
    process.env.FCM_SERVER_KEY = 'server-key-123';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pushProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fcmPushProvider } = require('./fcm-push.provider');
    expect(pushProvider).toBe(fcmPushProvider);
    delete process.env.PUSH_PROVIDER;
    delete process.env.FCM_SERVER_KEY;
  });
});

describe('fcmPushProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('mengirim POST dengan header Authorization: key=...', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fcmPushProvider } = require('./fcm-push.provider');
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch as never;

    await fcmPushProvider.send({ deviceToken: 'device-abc', title: 'Halo', body: 'Ada update' });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://fcm.googleapis.com/fcm/send');
    expect(options.headers.Authorization).toContain('key=');
    const body = JSON.parse(options.body);
    expect(body.to).toBe('device-abc');
    expect(body.notification.title).toBe('Halo');
  });

  it('melempar error kalau FCM mengembalikan status bukan 2xx', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fcmPushProvider } = require('./fcm-push.provider');
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' }) as never;

    await expect(fcmPushProvider.send({ deviceToken: 'x', title: 'a', body: 'b' })).rejects.toThrow(
      '401'
    );
  });
});
