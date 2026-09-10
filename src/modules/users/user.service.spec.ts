import { UserService } from './user.service';
import type { UserRepository } from './user.repository';
import type { RoleName } from '../../shared/types/role';
import { NotFoundError } from '../../shared/utils/http-error';

/**
 * Catatan konsolidasi (#2 — Auth): test untuk `registerUser` dan
 * `login` yang sebelumnya ada di file ini SUDAH DIPINDAH ke
 * `modules/auth/auth.service.spec.ts`, mengikuti kepindahan
 * implementasinya. File ini sekarang hanya menguji apa yang tersisa
 * di `UserService`: pengambilan profil dan daftar user (admin).
 */
describe('UserService', () => {
  let userService: UserService;
  let userRepository: jest.Mocked<UserRepository>;

  const dbUser = {
    id: 'user-123',
    email: 'budi@example.com',
    password: 'hashed-password-from-db',
    name: 'Budi Santoso',
    role: 'USER' as unknown as RoleName,
    emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    tenantId: null,
    mfaEnabled: false,
    mfaSecret: null,
    mfaEnabledAt: null,
  };

  beforeEach(() => {
    userRepository = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;

    userService = new UserService(userRepository);
  });

  describe('getProfile', () => {
    it('berhasil mengembalikan profil tanpa field password ketika user ditemukan', async () => {
      userRepository.findById.mockResolvedValue(dbUser);

      const result = await userService.getProfile(dbUser.id);

      expect(userRepository.findById).toHaveBeenCalledWith(dbUser.id);
      expect(result).toEqual({
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        createdAt: dbUser.createdAt,
      });
      expect(result).not.toHaveProperty('password');
    });

    it('melempar NotFoundError ketika user tidak ditemukan', async () => {
      userRepository.findById.mockResolvedValue(null);

      await expect(userService.getProfile('unknown-id')).rejects.toThrow(NotFoundError);
    });
  });

  describe('listUsers', () => {
    it('berhasil mengembalikan user dipaginasi, tanpa field password pada tiap entri', async () => {
      const secondUser = { ...dbUser, id: 'user-456', email: 'sari@example.com', name: 'Sari' };
      userRepository.findMany.mockResolvedValue({ data: [dbUser, secondUser], total: 2 });

      const result = await userService.listUsers({ page: 1, limit: 20 });

      expect(userRepository.findMany).toHaveBeenCalledWith({ skip: 0, take: 20 });
      expect(result.data).toHaveLength(2);
      result.data.forEach((user) => expect(user).not.toHaveProperty('password'));
      expect(result.data[0]).toEqual({
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        createdAt: dbUser.createdAt,
      });
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });

    it('mengembalikan data kosong ketika belum ada user sama sekali', async () => {
      userRepository.findMany.mockResolvedValue({ data: [], total: 0 });

      const result = await userService.listUsers({ page: 1, limit: 20 });

      expect(result.data).toEqual([]);
    });
  });

  describe('deleteUser', () => {
    it('soft-delete user yang ada, lalu invalidasi cache profilnya', async () => {
      userRepository.findById.mockResolvedValue(dbUser);

      await userService.deleteUser(dbUser.id);

      expect(userRepository.delete).toHaveBeenCalledWith(dbUser.id);
    });

    it('melempar NotFoundError ketika user yang mau dihapus tidak ada (atau sudah dihapus sebelumnya)', async () => {
      userRepository.findById.mockResolvedValue(null);

      await expect(userService.deleteUser('unknown-id')).rejects.toThrow(NotFoundError);
      expect(userRepository.delete).not.toHaveBeenCalled();
    });
  });
});
