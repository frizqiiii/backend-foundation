import { createWebhookEndpointSchema } from './webhook.dto';

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
      createWebhookEndpointSchema.safeParse({ url: 'bukan-url', eventTypes: ['x'] }).success
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
});
