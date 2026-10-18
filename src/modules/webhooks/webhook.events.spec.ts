import { dispatchWebhook, WEBHOOK_EVENT_TYPES } from './webhook.events';
import { logger } from '../../shared/logger';

describe('dispatchWebhook (R20)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('tanpa trigger (undefined): tidak melakukan apa pun dan tidak melempar', () => {
    expect(() =>
      dispatchWebhook(undefined, WEBHOOK_EVENT_TYPES.PRODUCT_CREATED, { id: 'p1' })
    ).not.toThrow();
  });

  it('memanggil trigger dengan eventType dan payload apa adanya', () => {
    const trigger = jest.fn().mockResolvedValue(undefined);

    dispatchWebhook({ trigger }, WEBHOOK_EVENT_TYPES.EVENT_DELETED, { id: 'e1' });

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith('event.deleted', { id: 'e1' });
  });

  it('TIDAK menunggu trigger: kembali seketika walau trigger belum selesai', () => {
    let finish: () => void = () => undefined;
    const trigger = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );

    const result = dispatchWebhook({ trigger }, WEBHOOK_EVENT_TYPES.PRODUCT_DELETED, { id: 'p1' });

    expect(result).toBeUndefined();
    expect(trigger).toHaveBeenCalledTimes(1);
    finish();
  });

  it('trigger yang menolak (reject) tidak menghasilkan unhandled rejection: hanya dicatat sebagai warning', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const trigger = jest.fn().mockRejectedValue(new Error('boom'));

    dispatchWebhook({ trigger }, WEBHOOK_EVENT_TYPES.PRODUCT_UPGRADED, { id: 'p1' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'product.upgraded' }),
      expect.stringContaining('dispatchWebhook')
    );
  });

  it('daftar event type tetap sesuai kontrak publik (dipakai klien yang mendaftarkan webhook)', () => {
    expect(Object.values(WEBHOOK_EVENT_TYPES).sort()).toEqual([
      'event.created',
      'event.deleted',
      'event.updated',
      'product.created',
      'product.deleted',
      'product.upgraded',
    ]);
  });
});
