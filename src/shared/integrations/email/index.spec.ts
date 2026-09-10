describe('email provider factory', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('memilih logEmailProvider secara default', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { emailProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logEmailProvider } = require('./log-email.provider');

    expect(emailProvider).toBe(logEmailProvider);
  });

  it('fallback ke logEmailProvider kalau EMAIL_PROVIDER=resend tapi RESEND_API_KEY kosong', () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = '';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { emailProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logEmailProvider } = require('./log-email.provider');

    expect(emailProvider).toBe(logEmailProvider);
  });

  it('memilih resendEmailProvider kalau EMAIL_PROVIDER=resend dan RESEND_API_KEY terisi', () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test_key';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { emailProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resendEmailProvider } = require('./resend-email.provider');

    expect(emailProvider).toBe(resendEmailProvider);
  });
});
