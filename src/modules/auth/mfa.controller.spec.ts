import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { MfaController } from './mfa.controller';
import type { MfaService } from './mfa.service';
import type { UserRepository } from '../users/user.repository';
import { NotFoundError, UnauthorizedError } from '../../shared/utils/http-error';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createMockRequest(overrides: Record<string, unknown> = {}): Request {
  return { body: {}, ...overrides } as unknown as Request;
}

const storedUser = { id: 'user-1', email: 'budi@example.com', password: 'hashed-password' };

describe('MfaController', () => {
  let mfaService: jest.Mocked<MfaService>;
  let userRepository: jest.Mocked<UserRepository>;
  let controller: MfaController;

  beforeEach(() => {
    jest.clearAllMocks();
    mfaService = {
      beginSetup: jest.fn(),
      confirmSetup: jest.fn(),
      disable: jest.fn(),
    } as unknown as jest.Mocked<MfaService>;
    userRepository = { findById: jest.fn() } as unknown as jest.Mocked<UserRepository>;
    controller = new MfaController(mfaService, userRepository);
  });

  describe('setup', () => {
    it('memuat user dari req.user.id, memulai setup MFA', async () => {
      const req = createMockRequest({ user: { id: 'user-1' } });
      const res = createMockResponse();
      userRepository.findById.mockResolvedValue(storedUser as never);
      const setupResult = { secret: 'SECRET', otpauthUrl: 'otpauth://...' };
      mfaService.beginSetup.mockResolvedValue(setupResult as never);

      await controller.setup(req, res);

      expect(userRepository.findById).toHaveBeenCalledWith('user-1');
      expect(mfaService.beginSetup).toHaveBeenCalledWith(storedUser);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: setupResult }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await expect(controller.setup(req, res)).rejects.toThrow(UnauthorizedError);
      expect(userRepository.findById).not.toHaveBeenCalled();
    });

    it('P5 — melempar NotFoundError kalau req.user.id ada tapi user sudah tidak ditemukan di DB (mis. terhapus sesaat setelah token diterbitkan)', async () => {
      const req = createMockRequest({ user: { id: 'user-1' } });
      const res = createMockResponse();
      userRepository.findById.mockResolvedValue(null);

      await expect(controller.setup(req, res)).rejects.toThrow(NotFoundError);
      expect(mfaService.beginSetup).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('mengonfirmasi setup dengan kode TOTP, membalas recoveryCodes', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, body: { code: '123456' } });
      const res = createMockResponse();
      userRepository.findById.mockResolvedValue(storedUser as never);
      mfaService.confirmSetup.mockResolvedValue(['CODE1', 'CODE2'] as never);

      await controller.confirm(req, res);

      expect(mfaService.confirmSetup).toHaveBeenCalledWith(storedUser, '123456');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: { recoveryCodes: ['CODE1', 'CODE2'] } })
      );
    });

    it('P5 — kode tidak valid (bukan 6 digit) ditolak validasi SEBELUM memuat user/memanggil service', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, body: { code: '123' } });
      const res = createMockResponse();

      await expect(controller.confirm(req, res)).rejects.toThrow();
      expect(userRepository.findById).not.toHaveBeenCalled();
      expect(mfaService.confirmSetup).not.toHaveBeenCalled();
    });
  });

  describe('disable', () => {
    it('menonaktifkan MFA kalau password cocok (bcrypt.compare true)', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, body: { password: 'benar' } });
      const res = createMockResponse();
      userRepository.findById.mockResolvedValue(storedUser as never);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await controller.disable(req, res);

      expect(bcrypt.compare).toHaveBeenCalledWith('benar', 'hashed-password');
      expect(mfaService.disable).toHaveBeenCalledWith(storedUser);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
    });

    it('P5 — melempar UnauthorizedError kalau password SALAH (bcrypt.compare false), TIDAK menonaktifkan MFA', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, body: { password: 'salah' } });
      const res = createMockResponse();
      userRepository.findById.mockResolvedValue(storedUser as never);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(controller.disable(req, res)).rejects.toThrow(UnauthorizedError);
      expect(mfaService.disable).not.toHaveBeenCalled();
    });

    it('P5 — melempar UnauthorizedError kalau user.password null (mis. akun OAuth-only, tidak pernah set password) — TANPA memanggil bcrypt.compare sama sekali', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, body: { password: 'apa saja' } });
      const res = createMockResponse();
      userRepository.findById.mockResolvedValue({ ...storedUser, password: null } as never);

      await expect(controller.disable(req, res)).rejects.toThrow(UnauthorizedError);
      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(mfaService.disable).not.toHaveBeenCalled();
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ body: { password: 'x' } });
      const res = createMockResponse();

      await expect(controller.disable(req, res)).rejects.toThrow(UnauthorizedError);
      expect(userRepository.findById).not.toHaveBeenCalled();
    });
  });
});
