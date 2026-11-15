import { createWebhookEndpointSchema } from './webhook.dto';
import { WEBHOOK_EVENT_TYPE_LIST } from './webhook.events';

describe('createWebhookEndpointSchema', () => {
  it('menerima url valid dan eventTypes minimal satu', () => {
    const result = createWebhookEndpointSchema.safeParse({
      url: 'https://example.com/hooks',
      eventTypes: ['product.created'],
    });
    expect(result.success).toBe(true);
  });

  it('menolak url yang bukan format URL valid', () => {
    expect(
      createWebhookEndpointSchema.safeParse({ url: 'bukan-url', eventTypes: ['product.created'] })
        .success
    ).toBe(false);
  });

  it('menolak eventTypes array kosong', () => {
    expect(
      createWebhookEndpointSchema.safeParse({ url: 'https://example.com', eventTypes: [] }).success
    ).toBe(false);
  });

  it('menerima beberapa eventTypes sekaligus', () => {
    const result = createWebhookEndpointSchema.parse({
      url: 'https://example.com/hooks',
      eventTypes: ['product.created', 'event.created'],
    });
    expect(result.eventTypes).toHaveLength(2);
  });

  describe('batas jumlah eventTypes', () => {
    const url = 'https://example.com/hooks';
    const maxCount = WEBHOOK_EVENT_TYPE_LIST.length;

    it('menerima seluruh event type yang valid sekaligus', () => {
      const result = createWebhookEndpointSchema.safeParse({
        url,
        eventTypes: [...WEBHOOK_EVENT_TYPE_LIST],
      });

      expect(result.success).toBe(true);
    });

    it('menerima tepat batas jumlah, menolak satu di atasnya dengan pesan jumlah', () => {
      const atLimit = Array.from({ length: maxCount }, () => 'product.created');
      const overLimit = Array.from({ length: maxCount + 1 }, () => 'product.created');

      expect(createWebhookEndpointSchema.safeParse({ url, eventTypes: atLimit }).success).toBe(
        true
      );
      const result = createWebhookEndpointSchema.safeParse({ url, eventTypes: overLimit });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].path).toEqual(['eventTypes']);
        expect(result.error.issues[0].message).toBe(
          'Jumlah event type melebihi batas yang diizinkan'
        );
      }
    });

    it('array jauh melebihi batas berisi nama salah menghasilkan SATU isu saja', () => {
      const huge = Array.from({ length: 5000 }, () => 'typo');

      const result = createWebhookEndpointSchema.safeParse({ url, eventTypes: huge });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
      }
    });

    it('array kosong tetap ditolak dengan pesan "minimal satu"', () => {
      const result = createWebhookEndpointSchema.safeParse({ url, eventTypes: [] });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Minimal satu event type harus dipilih');
      }
    });
  });

  describe('R20b — event type dibatasi ke daftar yang dipicu aplikasi', () => {
    const url = 'https://example.com/hooks';

    it.each([
      'product.created',
      'product.upgraded',
      'product.deleted',
      'event.created',
      'event.updated',
      'event.deleted',
    ])('menerima %s', (eventType) => {
      expect(createWebhookEndpointSchema.safeParse({ url, eventTypes: [eventType] }).success).toBe(
        true
      );
    });

    it.each(['prduct.created', 'product.created ', 'PRODUCT.CREATED', 'x', '*', ''])(
      'menolak nama yang tidak dikenal: %j',
      (eventType) => {
        const result = createWebhookEndpointSchema.safeParse({ url, eventTypes: [eventType] });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe(
            'Event type tidak dikenal. Lihat daftar event type yang didukung di dokumentasi API'
          );
        }
      }
    );

    it('menolak kalau SATU saja dari beberapa nama tidak dikenal', () => {
      expect(
        createWebhookEndpointSchema.safeParse({ url, eventTypes: ['product.created', 'typo'] })
          .success
      ).toBe(false);
    });
  });
});
