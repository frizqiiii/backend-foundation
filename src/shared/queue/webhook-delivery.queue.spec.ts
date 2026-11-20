jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue(undefined) })),
}));

// Spec ini menguji PENGIRIMAN, bukan SSRF: `assertSafeOutboundUrl` melakukan resolusi DNS nyata
// (`dns.promises.lookup`), sehingga tes bergantung pada jaringan dan bisa melewati batas 5 detik Jest.
// Guard-nya sendiri sudah diuji di `ssrf-guard.spec.ts` dengan DNS yang di-mock; di sini cukup
// dikunci KETERHUBUNGANNYA (dipanggil dengan URL tujuan, sebelum fetch, dan penolakannya menghentikan
// pengiriman). Fungsi pembungkus dipakai karena modul dimuat di dalam `jest.isolateModulesAsync`
// (registry terpisah): referensi `mock...` di bawah tetap SATU instance yang sama.
const mockAssertSafeOutboundUrl = jest.fn();

jest.mock('../security/ssrf-guard', () => ({
  assertSafeOutboundUrl: (url: string) => mockAssertSafeOutboundUrl(url),
}));

describe('webhook-delivery.queue', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockAssertSafeOutboundUrl.mockReset().mockResolvedValue(undefined);
  });

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

    it('memeriksa URL tujuan dengan SSRF guard SEBELUM fetch (anti DNS rebinding saat pengiriman)', async () => {
      const order: string[] = [];
      mockAssertSafeOutboundUrl.mockImplementation(async () => {
        order.push('guard');
      });
      global.fetch = jest.fn().mockImplementation(async () => {
        order.push('fetch');
        return { ok: true };
      }) as never;

      await enqueueWebhookDelivery({
        webhookEndpointId: 'wh-1',
        url: 'https://example.com/webhook',
        secret: 'secret',
        eventType: 'product.created',
        payload: {},
        deliveryId: 'delivery-abc-789',
      });

      expect(mockAssertSafeOutboundUrl).toHaveBeenCalledWith('https://example.com/webhook');
      expect(order).toEqual(['guard', 'fetch']);
    });

    it('guard MENOLAK URL → error dilempar apa adanya dan fetch TIDAK dipanggil sama sekali', async () => {
      mockAssertSafeOutboundUrl.mockRejectedValue(
        new Error('URL menunjuk ke alamat IP yang tidak diizinkan')
      );
      const mockFetch = jest.fn();
      global.fetch = mockFetch as never;

      await expect(
        enqueueWebhookDelivery({
          webhookEndpointId: 'wh-1',
          url: 'https://example.com/webhook',
          secret: 'secret',
          eventType: 'product.created',
          payload: {},
          deliveryId: 'delivery-abc-000',
        })
      ).rejects.toThrow('URL menunjuk ke alamat IP yang tidak diizinkan');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
