describe('sms provider factory', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('memilih logSmsProvider secara default', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { smsProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logSmsProvider } = require('./log-sms.provider');
    expect(smsProvider).toBe(logSmsProvider);
  });

  it('fallback ke log kalau SMS_PROVIDER=twilio tapi kredensial belum lengkap', () => {
    process.env.SMS_PROVIDER = 'twilio';
    process.env.TWILIO_ACCOUNT_SID = '';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { smsProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logSmsProvider } = require('./log-sms.provider');
    expect(smsProvider).toBe(logSmsProvider);
    delete process.env.SMS_PROVIDER;
  });

  it('memilih twilioSmsProvider kalau kredensial lengkap', () => {
    process.env.SMS_PROVIDER = 'twilio';
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_FROM_NUMBER = '+15550001111';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { smsProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { twilioSmsProvider } = require('./twilio-sms.provider');
    expect(smsProvider).toBe(twilioSmsProvider);
    delete process.env.SMS_PROVIDER;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  });
});

describe('twilioSmsProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('mengirim POST dengan Basic Auth dan body form-urlencoded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { twilioSmsProvider } = require('./twilio-sms.provider');
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch as never;

    await twilioSmsProvider.send({ to: '+15559998888', message: 'Kode OTP Anda: 123456' });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('api.twilio.com');
    expect(options.headers.Authorization).toContain('Basic');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(options.body).toContain('To=%2B15559998888');
  });

  it('melempar error kalau Twilio mengembalikan status bukan 2xx', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { twilioSmsProvider } = require('./twilio-sms.provider');
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => 'Invalid number' }) as never;

    await expect(twilioSmsProvider.send({ to: 'bad', message: 'x' })).rejects.toThrow('400');
  });
});
