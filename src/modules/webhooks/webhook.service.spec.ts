import { WebhookService } from './webhook.service';
import type { WebhookRepository } from './webhook.repository';
import { encryptionService } from '../../shared/security/encryption.service';
import { enqueueWebhookDelivery } from '../../shared/queue/webhook-delivery.queue';
import { NotFoundError } from '../../shared/utils/http-error';

jest.mock('../../shared/queue/webhook-delivery.queue', () => ({
  enqueueWebhookDelivery: jest.fn(),
}));

const mockedEnqueue = enqueueWebhookDelivery as jest.Mock;

describe('WebhookService', () => {
  let webhookRepository: jest.Mocked<WebhookRepository>;
  let webhookService: WebhookService;

  const owner = { id: 'user-1' };

  const storedEndpoint = {
    id: 'wh-1',
    userId: owner.id,
    tenantId: null,
    url: 'https://example.com/webhook',
    secret: '', // diisi per-test lewat encryptionService.encrypt
    eventTypes: ['product.created'],
    active: true,
    createdAt: new Date(),
    revokedAt: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    webhookRepository = {
      create: jest.fn(),
      findManyForUser: jest.fn(),
      findByIdForUser: jest.fn(),
      revoke: jest.fn(),
      findActiveByEventType: jest.fn(),
    } as unknown as jest.Mocked<WebhookRepository>;

    webhookService = new WebhookService(webhookRepository);
  });

  describe('register', () => {
    it('menyimpan secret TERENKRIPSI (bukan plaintext) dan mengembalikan secret MENTAH satu kali', async () => {
      webhookRepository.create.mockResolvedValue({
        ...storedEndpoint,
        secret: 'irrelevant-encrypted-value',
      });

      const result = await webhookService.register(owner, {
        url: 'https://example.com/webhook',
        eventTypes: ['product.created'],
      });

      const [createArgs] = webhookRepository.create.mock.calls[0];
      expect(createArgs.encryptedSecret).not.toBe(result.secret);
      expect(encryptionService.decrypt(createArgs.encryptedSecret)).toBe(result.secret);
      expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('listForUser', () => {
    it('P5 — memetakan endpoint milik user ke summary DTO TANPA mengembalikan secret', async () => {
      webhookRepository.findManyForUser.mockResolvedValue([storedEndpoint]);

      const result = await webhookService.listForUser(owner.id);

      expect(webhookRepository.findManyForUser).toHaveBeenCalledWith(owner.id);
      expect(result).toEqual([
        {
          id: 'wh-1',
          url: 'https://example.com/webhook',
          eventTypes: ['product.created'],
          active: true,
          createdAt: storedEndpoint.createdAt,
          revokedAt: null,
        },
      ]);
      expect(result[0]).not.toHaveProperty('secret');
    });
  });

  describe('revoke', () => {
    it('melempar NotFoundError kalau endpoint tidak ditemukan/bukan milik user ini', async () => {
      webhookRepository.findByIdForUser.mockResolvedValue(null);
      await expect(webhookService.revoke(owner.id, 'wh-x')).rejects.toThrow(NotFoundError);
    });

    it('idempotent — tidak error kalau endpoint sudah revoked sebelumnya', async () => {
      webhookRepository.findByIdForUser.mockResolvedValue({ ...storedEndpoint, active: false });
      await webhookService.revoke(owner.id, storedEndpoint.id);
      expect(webhookRepository.revoke).not.toHaveBeenCalled();
    });

    it('mencabut endpoint yang ditemukan & masih aktif', async () => {
      webhookRepository.findByIdForUser.mockResolvedValue(storedEndpoint);
      await webhookService.revoke(owner.id, storedEndpoint.id);
      expect(webhookRepository.revoke).toHaveBeenCalledWith(storedEndpoint.id);
    });
  });

  describe('trigger', () => {
    it('meng-enqueue delivery untuk SETIAP endpoint aktif yang cocok dengan eventType, dengan secret yang sudah didekripsi', async () => {
      const encryptedSecret = encryptionService.encrypt('raw-secret-value');
      webhookRepository.findActiveByEventType.mockResolvedValue([
        { ...storedEndpoint, secret: encryptedSecret },
      ]);

      await webhookService.trigger('product.created', { id: 'p1' });

      expect(mockedEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookEndpointId: 'wh-1',
          url: storedEndpoint.url,
          secret: 'raw-secret-value',
          eventType: 'product.created',
          payload: { id: 'p1' },
          // Finding #22 — deliveryId di-generate (bukan diteruskan
          // dari pemanggil), dan berbentuk UUID, bukan sekadar string
          // apa pun.
          deliveryId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
          ),
        })
      );
    });

    it('TIDAK melempar error kalau enqueue gagal untuk satu endpoint — endpoint lain tetap diproses', async () => {
      const encryptedSecret = encryptionService.encrypt('raw-secret-value');
      webhookRepository.findActiveByEventType.mockResolvedValue([
        { ...storedEndpoint, id: 'wh-1', secret: encryptedSecret },
        { ...storedEndpoint, id: 'wh-2', secret: encryptedSecret },
      ]);
      mockedEnqueue.mockRejectedValueOnce(new Error('Redis down')).mockResolvedValueOnce(undefined);

      await expect(webhookService.trigger('product.created', {})).resolves.toBeUndefined();
      expect(mockedEnqueue).toHaveBeenCalledTimes(2);
    });

    it('tidak melakukan apa pun kalau tidak ada endpoint yang cocok', async () => {
      webhookRepository.findActiveByEventType.mockResolvedValue([]);

      await webhookService.trigger('product.created', {});

      expect(mockedEnqueue).not.toHaveBeenCalled();
    });
  });
});
