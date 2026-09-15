import type { Request, Response } from 'express';
import { PrivacyController } from './privacy.controller';
import type { PrivacyService } from './privacy.service';
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

describe('PrivacyController', () => {
  let privacyService: jest.Mocked<PrivacyService>;
  let controller: PrivacyController;

  beforeEach(() => {
    privacyService = {
      requestSelfErasure: jest.fn(),
      eraseForUser: jest.fn(),
    } as unknown as jest.Mocked<PrivacyService>;
    controller = new PrivacyController(privacyService);
  });

  describe('eraseSelf', () => {
    it('menolak kalau req.user tidak ada (harusnya tidak pernah terjadi lewat authMiddleware, pertahanan berlapis)', async () => {
      const req = createMockRequest({ user: undefined, body: { password: 'x' } });
      const res = createMockResponse();
      await expect(controller.eraseSelf(req, res)).rejects.toThrow(UnauthorizedError);
      expect(privacyService.requestSelfErasure).not.toHaveBeenCalled();
    });

    it('SELALU beroperasi pada req.user.id — TIDAK PERNAH menerima id dari body/param', async () => {
      privacyService.requestSelfErasure.mockResolvedValue({ userId: 'u1', erasedAt: new Date() });
      const req = createMockRequest({
        user: { id: 'u1', role: 'USER' },
        body: { password: 'benar123', id: 'user-lain-yang-dicoba-suntikkan' },
      });
      const res = createMockResponse();

      await controller.eraseSelf(req, res);

      expect(privacyService.requestSelfErasure).toHaveBeenCalledWith('u1', 'benar123');
    });
  });

  describe('eraseByAdmin', () => {
    it('meneruskan id dari path param ke service', async () => {
      privacyService.eraseForUser.mockResolvedValue({ userId: 'u2', erasedAt: new Date() });
      const req = createMockRequest({ params: { id: 'u2' } });
      const res = createMockResponse();

      await controller.eraseByAdmin(req, res);

      expect(privacyService.eraseForUser).toHaveBeenCalledWith('u2');
      expect(res.json).toHaveBeenCalled();
    });
  });
});
