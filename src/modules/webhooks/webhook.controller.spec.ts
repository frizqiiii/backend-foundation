import type { Request, Response } from 'express';
import { WebhookController } from './webhook.controller';
import type { WebhookService } from './webhook.service';
import { UnauthorizedError } from '../../shared/utils/http-error';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createMockRequest(overrides: Record<string, unknown> = {}): Request {
  return { params: {}, body: {}, ...overrides } as unknown as Request;
}

describe('WebhookController', () => {
  let webhookService: jest.Mocked<WebhookService>;
  let controller: WebhookController;

  beforeEach(() => {
    webhookService = {
      register: jest.fn(),
      listForUser: jest.fn(),
      revoke: jest.fn(),
    } as unknown as jest.Mocked<WebhookService>;
    controller = new WebhookController(webhookService);
  });

  describe('create', () => {
    it('mendaftarkan endpoint atas nama req.user.id, membalas 201 dengan secret', async () => {
      const req = createMockRequest({
        user: { id: 'user-1' },
        body: { url: 'https://example.com/hooks', eventTypes: ['product.created'] },
      });
      const res = createMockResponse();
      const result = {
        id: 'wh-1',
        url: 'https://example.com/hooks',
        secret: 'sekret',
        eventTypes: ['product.created'],
      };
      webhookService.register.mockResolvedValue(result as never);

      await controller.create(req, res);

      expect(webhookService.register).toHaveBeenCalledWith(
        { id: 'user-1' },
        { url: 'https://example.com/hooks', eventTypes: ['product.created'] }
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: result }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ body: { url: 'https://example.com', eventTypes: ['x'] } });
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow(UnauthorizedError);
      expect(webhookService.register).not.toHaveBeenCalled();
    });

    it('P5 — body tidak valid (url bukan URL) dilempar sebagai error validasi', async () => {
      const req = createMockRequest({
        user: { id: 'user-1' },
        body: { url: 'bukan-url', eventTypes: ['x'] },
      });
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow();
      expect(webhookService.register).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('membalas daftar endpoint milik req.user.id', async () => {
      const req = createMockRequest({ user: { id: 'user-1' } });
      const res = createMockResponse();
      const endpoints = [{ id: 'wh-1' }];
      webhookService.listForUser.mockResolvedValue(endpoints as never);

      await controller.list(req, res);

      expect(webhookService.listForUser).toHaveBeenCalledWith('user-1');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: endpoints }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await expect(controller.list(req, res)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('revoke', () => {
    it('mencabut endpoint milik req.user.id, membalas 200 data null', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, params: { id: 'wh-1' } });
      const res = createMockResponse();

      await controller.revoke(req, res);

      expect(webhookService.revoke).toHaveBeenCalledWith('user-1', 'wh-1');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ params: { id: 'wh-1' } });
      const res = createMockResponse();

      await expect(controller.revoke(req, res)).rejects.toThrow(UnauthorizedError);
      expect(webhookService.revoke).not.toHaveBeenCalled();
    });
  });
});
