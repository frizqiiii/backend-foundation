import { tokenBlacklist } from './token-blacklist';
import { prisma } from '../config/database';

jest.mock('../config/database', () => ({
  prisma: { blacklistedToken: { findUnique: jest.fn(), create: jest.fn() } },
}));

const mockedPrisma = prisma as unknown as {
  blacklistedToken: { findUnique: jest.Mock; create: jest.Mock };
};

describe('tokenBlacklist', () => {
  describe('isBlacklisted', () => {
    it('mengembalikan true kalau entry ditemukan', async () => {
      mockedPrisma.blacklistedToken.findUnique.mockResolvedValue({ jti: 'jti-1' });

      const result = await tokenBlacklist.isBlacklisted('jti-1');

      expect(mockedPrisma.blacklistedToken.findUnique).toHaveBeenCalledWith({
        where: { jti: 'jti-1' },
      });
      expect(result).toBe(true);
    });

    it('mengembalikan false kalau entry tidak ditemukan (null)', async () => {
      mockedPrisma.blacklistedToken.findUnique.mockResolvedValue(null);

      const result = await tokenBlacklist.isBlacklisted('jti-2');

      expect(result).toBe(false);
    });
  });

  describe('add', () => {
    it('menyimpan entry baru dengan jti/userId/expiresAt', async () => {
      const params = { jti: 'jti-3', userId: 'user-1', expiresAt: new Date('2026-12-31') };

      await tokenBlacklist.add(params);

      expect(mockedPrisma.blacklistedToken.create).toHaveBeenCalledWith({ data: params });
    });
  });
});
