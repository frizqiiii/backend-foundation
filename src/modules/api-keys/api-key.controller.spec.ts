import type { Request, Response } from 'express';
import { ApiKeyController } from './api-key.controller';
import type { ApiKeyService } from './api-key.service';
import type { AuditService } from '../audit/audit.service';
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

describe('ApiKeyController', () => {
  let apiKeyService: jest.Mocked<ApiKeyService>;
  let auditService: jest.Mocked<AuditService>;
  let controller: ApiKeyController;

  beforeEach(() => {
    apiKeyService = {
      create: jest.fn(),
      listForUser: jest.fn(),
      revoke: jest.fn(),
      updateRateLimitOverride: jest.fn(),
    } as unknown as jest.Mocked<ApiKeyService>;
    auditService = { logUpdate: jest.fn() } as unknown as jest.Mocked<AuditService>;
    controller = new ApiKeyController(apiKeyService, auditService);
  });

  describe('create', () => {
    it('membuat key dengan identitas+role req.user, membalas 201 dengan rawKey', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', role: 'USER' },
        body: { name: 'CI pipeline' },
      });
      const res = createMockResponse();
      const result = { id: 'key-1', rawKey: 'bfk_abc', keyPrefix: 'bfk_ab' };
      apiKeyService.create.mockResolvedValue(result as never);

      await controller.create(req, res);

      expect(apiKeyService.create).toHaveBeenCalledWith(
        { id: 'user-1', role: 'USER' },
        { name: 'CI pipeline' }
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: result }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ body: { name: 'CI pipeline' } });
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow(UnauthorizedError);
      expect(apiKeyService.create).not.toHaveBeenCalled();
    });

    it('P5 — body tidak valid (name kosong) dilempar sebagai error validasi', async () => {
      const req = createMockRequest({ user: { id: 'user-1', role: 'USER' }, body: { name: '' } });
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow();
      expect(apiKeyService.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('membalas daftar key milik req.user.id', async () => {
      const req = createMockRequest({ user: { id: 'user-1', role: 'USER' } });
      const res = createMockResponse();
      const keys = [{ id: 'key-1' }];
      apiKeyService.listForUser.mockResolvedValue(keys as never);

      await controller.list(req, res);

      expect(apiKeyService.listForUser).toHaveBeenCalledWith('user-1');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: keys }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await expect(controller.list(req, res)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('revoke', () => {
    it('mencabut key milik req.user.id, membalas 200 data null', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', role: 'USER' },
        params: { id: 'key-1' },
      });
      const res = createMockResponse();

      await controller.revoke(req, res);

      expect(apiKeyService.revoke).toHaveBeenCalledWith('user-1', 'key-1');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ params: { id: 'key-1' } });
      const res = createMockResponse();

      await expect(controller.revoke(req, res)).rejects.toThrow(UnauthorizedError);
      expect(apiKeyService.revoke).not.toHaveBeenCalled();
    });
  });

  describe('updateRateLimitOverride (T4)', () => {
    function reqFor(body: unknown, user: unknown = { id: 'admin-1' }) {
      return createMockRequest({
        params: { id: 'key-1' },
        body,
        user,
        get: (header: string) => (header.toLowerCase() === 'user-agent' ? 'jest-agent' : undefined),
        headers: { 'user-agent': 'jest-agent' },
        ip: '10.0.0.7',
        socket: { remoteAddress: '10.0.0.7' },
      });
    }

    it('memvalidasi body, memanggil service dengan id dari URL, membalas 200', async () => {
      const res = createMockResponse();
      apiKeyService.updateRateLimitOverride.mockResolvedValue({
        apiKey: { id: 'key-1', rateLimitOverridePerMinute: 500 },
        previousValue: null,
      } as never);

      await controller.updateRateLimitOverride(reqFor({ rateLimitOverridePerMinute: 500 }), res);

      expect(apiKeyService.updateRateLimitOverride).toHaveBeenCalledWith('key-1', 500);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: { id: 'key-1', rateLimitOverridePerMinute: 500 } })
      );
    });

    it('mencatat audit UPDATE pada entity ApiKey: siapa (userId), dari nilai apa ke nilai apa', async () => {
      const res = createMockResponse();
      apiKeyService.updateRateLimitOverride.mockResolvedValue({
        apiKey: { id: 'key-1', rateLimitOverridePerMinute: 500 },
        previousValue: null,
      } as never);

      await controller.updateRateLimitOverride(reqFor({ rateLimitOverridePerMinute: 500 }), res);

      expect(auditService.logUpdate).toHaveBeenCalledTimes(1);
      expect(auditService.logUpdate).toHaveBeenCalledWith(
        'ApiKey',
        'key-1',
        expect.objectContaining({ userId: 'admin-1', userAgent: 'jest-agent' }),
        { field: 'rateLimitOverridePerMinute', from: null, to: 500 }
      );
    });

    it('body null MENGHAPUS override — diteruskan ke service sebagai null, bukan ditolak validasi', async () => {
      const res = createMockResponse();
      apiKeyService.updateRateLimitOverride.mockResolvedValue({
        apiKey: { id: 'key-1', rateLimitOverridePerMinute: null },
        previousValue: 500,
      } as never);

      await controller.updateRateLimitOverride(reqFor({ rateLimitOverridePerMinute: null }), res);

      expect(apiKeyService.updateRateLimitOverride).toHaveBeenCalledWith('key-1', null);
      expect(auditService.logUpdate).toHaveBeenCalledWith('ApiKey', 'key-1', expect.anything(), {
        field: 'rateLimitOverridePerMinute',
        from: 500,
        to: null,
      });
    });

    it('nilai 0 atau negatif ditolak validasi, service DAN audit TIDAK dipanggil', async () => {
      const res = createMockResponse();

      await expect(
        controller.updateRateLimitOverride(reqFor({ rateLimitOverridePerMinute: 0 }), res)
      ).rejects.toThrow();
      expect(apiKeyService.updateRateLimitOverride).not.toHaveBeenCalled();
      expect(auditService.logUpdate).not.toHaveBeenCalled();
    });

    it('nilai desimal ditolak validasi (harus bilangan bulat)', async () => {
      const res = createMockResponse();

      await expect(
        controller.updateRateLimitOverride(reqFor({ rateLimitOverridePerMinute: 12.5 }), res)
      ).rejects.toThrow();
      expect(apiKeyService.updateRateLimitOverride).not.toHaveBeenCalled();
    });

    it('service gagal (mis. key tidak ada): TIDAK ada audit dicatat untuk aksi yang tidak terjadi', async () => {
      const res = createMockResponse();
      apiKeyService.updateRateLimitOverride.mockRejectedValue(new Error('API key tidak ditemukan'));

      await expect(
        controller.updateRateLimitOverride(reqFor({ rateLimitOverridePerMinute: 500 }), res)
      ).rejects.toThrow();
      expect(auditService.logUpdate).not.toHaveBeenCalled();
    });

    it('tanpa req.user -> UnauthorizedError, tidak menulis apa pun', async () => {
      const res = createMockResponse();

      await expect(
        controller.updateRateLimitOverride(reqFor({ rateLimitOverridePerMinute: 500 }, null), res)
      ).rejects.toThrow(UnauthorizedError);
      expect(apiKeyService.updateRateLimitOverride).not.toHaveBeenCalled();
      expect(auditService.logUpdate).not.toHaveBeenCalled();
    });
  });
});
