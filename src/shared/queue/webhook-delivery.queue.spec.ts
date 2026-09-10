jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue(undefined) })),
}));

describe('webhook-delivery.queue', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('ketika Redis TIDAK dikonfigurasi (queueConnection null)', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    let enqueueWebhookDelivery: typeof import('./webhook-delivery.queue').enqueueWebhookDelivery;

    beforeAll(async () => {
      await jest.isolateModulesAsync(async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('./webhook-delivery.queue');
        enqueueWebhookDelivery = mod.enqueueWebhookDelivery;
        expect(mod.webhookDeliveryQueue).toBeNull();
      });
    });

    it('fallback ke eksekusi sinkron — memanggil fetch langsung dengan signature+timestamp+deliveryId yang benar (Finding #22)', async () => {
      const mockFetch = jest.fn().mockResolvedValue({ ok: true });
      global.fetch = mockFetch as never;

      await enqueueWebhookDelivery({
        webhookEndpointId: 'wh-1',
        url: 'https://example.com/webhook',
        secret: 'endpoint-secret',
        eventType: 'product.created',
        payload: { id: 'p1' },
        deliveryId: 'delivery-abc-123',
      });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://example.com/webhook');
      expect(options.headers['X-Webhook-Event']).toBe('product.created');
      expect(options.headers['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      // Finding #22 — timestamp dikirim TERPISAH (header sendiri) TAPI
      // juga ikut ditandatangani (lihat webhook-signer.spec.ts) —
      // ini cuma mengecek headernya benar-benar terkirim & berbentuk
      // detik Unix, bukan menguji ulang isi HMAC-nya di sini.
      expect(options.headers['X-Webhook-Timestamp']).toMatch(/^\d+$/);
      expect(options.headers['X-Webhook-Delivery-Id']).toBe('delivery-abc-123');
      expect(JSON.parse(options.body)).toEqual({ event: 'product.created', data: { id: 'p1' } });
    });

    it('melempar error kalau endpoint penerima mengembalikan status bukan 2xx (memicu retry BullMQ)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as never;

      await expect(
        enqueueWebhookDelivery({
          webhookEndpointId: 'wh-1',
          url: 'https://example.com/webhook',
          secret: 'secret',
          eventType: 'product.created',
          payload: {},
          deliveryId: 'delivery-abc-456',
        })
      ).rejects.toThrow('500');
    });
  });
});
