import bcrypt from 'bcrypt';
import { PrivacyService } from './privacy.service';
import type { PrivacyRepository } from './privacy.repository';
import type { UserRepository } from '../users/user.repository';
import type { UploadRepository } from '../upload/upload.repository';
import { objectStorageProvider } from '../../shared/integrations/storage';
import { UnauthorizedError, NotFoundError, BadRequestError } from '../../shared/utils/http-error';

jest.mock('../../shared/integrations/storage', () => ({
  objectStorageProvider: { upload: jest.fn(), delete: jest.fn() },
}));

const mockedDelete = objectStorageProvider.delete as jest.Mock;

describe('PrivacyService', () => {
  let privacyRepository: jest.Mocked<PrivacyRepository>;
  let userRepository: jest.Mocked<UserRepository>;
  let uploadRepository: jest.Mocked<UploadRepository>;
  let service: PrivacyService;

  const erasedAt = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
    privacyRepository = {
      eraseUserData: jest.fn(),
    } as unknown as jest.Mocked<PrivacyRepository>;
    userRepository = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;
    uploadRepository = {
      findByUser: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<UploadRepository>;
    service = new PrivacyService(privacyRepository, userRepository, uploadRepository);
    privacyRepository.eraseUserData.mockResolvedValue({ id: 'u1', erasedAt } as never);
  });

  describe('requestSelfErasure', () => {
    it('menolak kalau user tidak ditemukan', async () => {
      userRepository.findById.mockResolvedValue(null);
      await expect(service.requestSelfErasure('u1', 'password123')).rejects.toThrow(NotFoundError);
    });

    it('menolak kalau password SALAH — TIDAK memanggil erasure sama sekali', async () => {
      const hashed = await bcrypt.hash('password-benar', 4);
      userRepository.findById.mockResolvedValue({ id: 'u1', password: hashed } as never);

      await expect(service.requestSelfErasure('u1', 'password-SALAH')).rejects.toThrow(
        UnauthorizedError
      );
      expect(privacyRepository.eraseUserData).not.toHaveBeenCalled();
    });

    it('meng-erasure kalau password BENAR', async () => {
      const hashed = await bcrypt.hash('password-benar', 4);
      userRepository.findById.mockResolvedValue({ id: 'u1', password: hashed } as never);

      const result = await service.requestSelfErasure('u1', 'password-benar');

      expect(privacyRepository.eraseUserData).toHaveBeenCalledWith('u1');
      expect(result).toEqual({ userId: 'u1', erasedAt });
    });

    it('akun SSO/OAuth-only (password: null) — melewati konfirmasi password, tetap boleh erasure (authMiddleware sudah membuktikan sesi sah)', async () => {
      userRepository.findById.mockResolvedValue({ id: 'u1', password: null } as never);

      const result = await service.requestSelfErasure('u1', 'apa-pun-diabaikan');

      expect(privacyRepository.eraseUserData).toHaveBeenCalledWith('u1');
      expect(result).toEqual({ userId: 'u1', erasedAt });
    });
  });

  describe('eraseForUser (admin/job-triggered)', () => {
    it('menolak kalau user tidak ditemukan', async () => {
      userRepository.findById.mockResolvedValue(null);
      await expect(service.eraseForUser('u1')).rejects.toThrow(NotFoundError);
    });

    it('menolak kalau user SUDAH pernah di-erasure sebelumnya', async () => {
      userRepository.findById.mockResolvedValue({ id: 'u1', erasedAt: new Date() } as never);
      await expect(service.eraseForUser('u1')).rejects.toThrow(BadRequestError);
      expect(privacyRepository.eraseUserData).not.toHaveBeenCalled();
    });

    it('meng-erasure kalau belum pernah diproses', async () => {
      userRepository.findById.mockResolvedValue({ id: 'u1', erasedAt: null } as never);
      const result = await service.eraseForUser('u1');
      expect(privacyRepository.eraseUserData).toHaveBeenCalledWith('u1');
      expect(result).toEqual({ userId: 'u1', erasedAt });
    });
  });

  describe('penghapusan file storage', () => {
    it('menghapus SEMUA objek storage milik user SEBELUM transaksi database erasure dimulai', async () => {
      userRepository.findById.mockResolvedValue({ id: 'u1', erasedAt: null } as never);
      uploadRepository.findByUser.mockResolvedValue([
        { id: 'f1', key: 'uploads/f1.png' },
        { id: 'f2', key: 'uploads/f2.png' },
      ] as never);

      await service.eraseForUser('u1');

      expect(mockedDelete).toHaveBeenCalledWith('uploads/f1.png');
      expect(mockedDelete).toHaveBeenCalledWith('uploads/f2.png');
      expect(mockedDelete).toHaveBeenCalledTimes(2);
    });

    it('SATU objek storage gagal dihapus TIDAK menghentikan erasure PII di database (dilanjutkan, dicatat sebagai error)', async () => {
      userRepository.findById.mockResolvedValue({ id: 'u1', erasedAt: null } as never);
      uploadRepository.findByUser.mockResolvedValue([
        { id: 'f1', key: 'uploads/f1.png' },
        { id: 'f2', key: 'uploads/f2.png' },
      ] as never);
      mockedDelete.mockRejectedValueOnce(new Error('S3 down')).mockResolvedValueOnce(undefined);

      const result = await service.eraseForUser('u1');

      expect(mockedDelete).toHaveBeenCalledTimes(2);
      expect(privacyRepository.eraseUserData).toHaveBeenCalledWith('u1');
      expect(result).toEqual({ userId: 'u1', erasedAt });
    });
  });
});
