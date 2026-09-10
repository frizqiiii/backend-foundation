describe('payment provider factory', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('memilih logPaymentProvider secara default', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { paymentProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logPaymentProvider } = require('./log-payment.provider');
    expect(paymentProvider).toBe(logPaymentProvider);
  });

  it('fallback ke log kalau PAYMENT_PROVIDER=stripe tapi STRIPE_SECRET_KEY kosong', () => {
    process.env.PAYMENT_PROVIDER = 'stripe';
    process.env.STRIPE_SECRET_KEY = '';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { paymentProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logPaymentProvider } = require('./log-payment.provider');
    expect(paymentProvider).toBe(logPaymentProvider);
    delete process.env.PAYMENT_PROVIDER;
  });

  it('memilih stripePaymentProvider kalau STRIPE_SECRET_KEY terisi', () => {
    process.env.PAYMENT_PROVIDER = 'stripe';
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { paymentProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stripePaymentProvider } = require('./stripe-payment.provider');
    expect(paymentProvider).toBe(stripePaymentProvider);
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.STRIPE_SECRET_KEY;
  });
});

describe('logPaymentProvider', () => {
  it('mengembalikan PaymentIntentResult dengan id & status placeholder, tidak melempar error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logPaymentProvider } = require('./log-payment.provider');

    const result = await logPaymentProvider.createPaymentIntent({ amount: 10000, currency: 'idr' });

    expect(result.id).toMatch(/^log_pi_/);
    expect(result.status).toBe('requires_payment_method');
  });
});

describe('stripePaymentProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('mengirim POST form-urlencoded dengan Bearer secret key', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stripePaymentProvider } = require('./stripe-payment.provider');
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'pi_123',
        status: 'requires_payment_method',
        client_secret: 'secret',
      }),
    });
    global.fetch = mockFetch as never;

    const result = await stripePaymentProvider.createPaymentIntent({
      amount: 5000,
      currency: 'usd',
    });

    expect(result).toEqual({
      id: 'pi_123',
      status: 'requires_payment_method',
      clientSecret: 'secret',
    });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(options.headers.Authorization).toContain('Bearer');
    expect(options.body).toContain('amount=5000');
  });

  it('melempar error dengan pesan dari Stripe kalau request gagal', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stripePaymentProvider } = require('./stripe-payment.provider');
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: { message: 'Your card was declined.' } }),
    }) as never;

    await expect(
      stripePaymentProvider.createPaymentIntent({ amount: 1000, currency: 'usd' })
    ).rejects.toThrow('Your card was declined.');
  });
});
