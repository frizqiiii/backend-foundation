import type { Request, Response } from 'express';
import { UserController } from './user.controller';
import type { UserService } from './user.service';
import type { AuditService } from '../audit/audit.service';
import { UnauthorizedError } from '../../shared/utils/http-error';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('UserController', () => {
  let userService: jest.Mocked<UserService>;
  let auditService: jest.Mocked<AuditService>;
  let controller: UserController;

  beforeEach(() => {
    userService = {
      getProfile: jest.fn(),
      listUsers: jest.fn(),
      deleteUser: jest.fn(),
    } as unknown as jest.Mocked<UserService>;
    auditService = { logDelete: jest.fn() } as unknown as jest.Mocked<AuditService>;
    controller = new UserController(userService, auditService);
  });

  describe('me', () => {
    it('membalas 200 dengan profil user dari req.user.id', async () => {
      const req = { user: { id: 'user-1' } } as unknown as Request;
      const res = createMockResponse();
      const profile = {
        id: 'user-1',
        email: 'budi@example.com',
        name: 'Budi',
        createdAt: new Date(),
      };
      userService.getProfile.mockResolvedValue(profile);

      await controller.me(req, res);

      expect(userService.getProfile).toHaveBeenCalledWith('user-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: profile })
      );
    });

    it('P5 — melempar UnauthorizedError (safety-net) kalau req.user tidak ada', async () => {
      const req = {} as Request;
      const res = createMockResponse();

      await expect(controller.me(req, res)).rejects.toThrow(UnauthorizedError);
      expect(userService.getProfile).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('mem-parsing query, memanggil listUsers, dan membalas data+meta', async () => {
      const req = { query: { page: '2', limit: '10' } } as unknown as Request;
      const res = createMockResponse();
      const result = {
        data: [{ id: 'u1' }],
        meta: { page: 2, limit: 10, total: 1, totalPages: 1 },
      };
      userService.listUsers.mockResolvedValue(result as never);

      await controller.list(req, res);

      expect(userService.listUsers).toHaveBeenCalledWith({ page: 2, limit: 10 });
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: result.data, meta: result.meta })
      );
    });

    it('P5 — query tidak valid (limit di luar batas) dilempar sebagai ZodError, bukan diteruskan diam-diam ke service', async () => {
      const req = { query: { limit: '9999' } } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.list(req, res)).rejects.toThrow();
      expect(userService.listUsers).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('menghapus user, mencatat audit log dengan IP/user-agent, dan membalas 200 dengan data null', async () => {
      const req = {
        user: { id: 'admin-1' },
        params: { id: 'user-to-delete' },
        ip: '10.0.0.5',
        get: jest.fn().mockReturnValue('curl/8.0'),
      } as unknown as Request;
      const res = createMockResponse();

      await controller.remove(req, res);

      expect(userService.deleteUser).toHaveBeenCalledWith('user-to-delete');
      expect(auditService.logDelete).toHaveBeenCalledWith('User', 'user-to-delete', {
        userId: 'admin-1',
        ipAddress: '10.0.0.5',
        userAgent: 'curl/8.0',
      });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: null }));
    });

    it('P5 — melempar UnauthorizedError (safety-net) kalau req.user tidak ada, dan TIDAK menghapus apa pun', async () => {
      const req = { params: { id: 'user-to-delete' } } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.remove(req, res)).rejects.toThrow(UnauthorizedError);
      expect(userService.deleteUser).not.toHaveBeenCalled();
      expect(auditService.logDelete).not.toHaveBeenCalled();
    });
  });
});
