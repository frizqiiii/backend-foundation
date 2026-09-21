import bcrypt from 'bcrypt';
import { PrivacyService } from './privacy.service';
import type { PrivacyRepository } from './privacy.repository';
import { UserRepository } from '../users/user.repository';
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
      findByIdIncludingDeleted: jest.fn(),
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
      userRepository.findByIdIncludingDeleted.mockResolvedValue(null);
      await expect(service.eraseForUser('u1')).rejects.toThrow(NotFoundError);
    });

    it('menolak kalau user SUDAH pernah di-erasure sebelumnya', async () => {
      userRepository.findByIdIncludingDeleted.mockResolvedValue({
        id: 'u1',
        erasedAt: new Date(),
      } as never);
      await expect(service.eraseForUser('u1')).rejects.toThrow(BadRequestError);
      expect(privacyRepository.eraseUserData).not.toHaveBeenCalled();
    });

    it('meng-erasure kalau belum pernah diproses', async () => {
      userRepository.findByIdIncludingDeleted.mockResolvedValue({
        id: 'u1',
        erasedAt: null,
      } as never);
      const result = await service.eraseForUser('u1');
      expect(privacyRepository.eraseUserData).toHaveBeenCalledWith('u1');
      expect(result).toEqual({ userId: 'u1', erasedAt });
    });
  });

  describe('penghapusan file storage', () => {
    it('menghapus SEMUA objek storage milik user SEBELUM transaksi database erasure dimulai', async () => {
      userRepository.findByIdIncludingDeleted.mockResolvedValue({
        id: 'u1',
        erasedAt: null,
      } as never);
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
      userRepository.findByIdIncludingDeleted.mockResolvedValue({
        id: 'u1',
        erasedAt: null,
      } as never);
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
  describe('temuan T15 — akun SOFT-DELETED (target utama job retensi) HARUS bisa di-erasure', () => {
    // UserRepository ASLI di atas prisma tiruan yang meniru semantik Prisma: `deletedAt: null`
    // berarti IS NULL. Unit test lain memakai UserRepository tiruan yang mengembalikan user apa pun,
    // sehingga ketidakcocokan finder ini tidak pernah terlihat.
    const softDeleted = {
      id: 'u1',
      email: 'lama@example.com',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      erasedAt: null,
    };
    function realUserRepository(): UserRepository {
      const prismaFake = {
        user: {
          findFirst: jest.fn(async ({ where }: { where: { id: string; deletedAt?: null } }) =>
            where.id === 'u1' && where.deletedAt === null
              ? null
              : where.id === 'u1'
                ? softDeleted
                : null
          ),
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
            where.id === 'u1' ? softDeleted : null
          ),
        },
      };
      return new UserRepository(prismaFake as never);
    }

    it('eraseForUser sukses untuk akun soft-deleted (sebelum perbaikan: NotFoundError untuk SETIAP kandidat job retensi)', async () => {
      const svc = new PrivacyService(privacyRepository, realUserRepository(), uploadRepository);

      await expect(svc.eraseForUser('u1')).resolves.toEqual({ userId: 'u1', erasedAt });
      expect(privacyRepository.eraseUserData).toHaveBeenCalledWith('u1');
    });

    it('kontrol: `findById` (jalur auth) memang menyembunyikan akun itu — jadi finder terpisah diperlukan', async () => {
      await expect(realUserRepository().findById('u1')).resolves.toBeNull();
      await expect(realUserRepository().findByIdIncludingDeleted('u1')).resolves.toBe(softDeleted);
    });

    it('akun soft-deleted yang SUDAH di-erasure tetap ditolak (tidak diproses ulang)', async () => {
      const repo = realUserRepository();
      jest
        .spyOn(repo, 'findByIdIncludingDeleted')
        .mockResolvedValue({ ...softDeleted, erasedAt: new Date() } as never);
      const svc = new PrivacyService(privacyRepository, repo, uploadRepository);

      await expect(svc.eraseForUser('u1')).rejects.toThrow(BadRequestError);
      expect(privacyRepository.eraseUserData).not.toHaveBeenCalled();
    });
  });
});
