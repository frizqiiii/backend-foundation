import type { PrismaClient } from '@prisma/client';
import { AuthRepository } from './auth.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    $transaction: jest.fn(),
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    emailVerificationToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    passwordResetToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    oAuthAccount: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('AuthRepository', () => {
  it('runInTransaction meneruskan fn langsung ke prisma.$transaction', async () => {
    const prisma = createMockPrisma();
    (prisma.$transaction as jest.Mock).mockImplementation((fn: (tx: unknown) => unknown) =>
      fn('tx-client')
    );
    const repository = new AuthRepository(prisma);
    const fn = jest.fn().mockResolvedValue('result');

    const result = await repository.runInTransaction(fn);

    expect(prisma.$transaction).toHaveBeenCalledWith(fn);
    expect(result).toBe('result');
  });

  describe('Refresh Token', () => {
    it('createRefreshToken meneruskan data langsung ke prisma', async () => {
      const prisma = createMockPrisma();
      const data = {
        tokenHash: 'hash',
        userId: 'u1',
        expiresAt: new Date(),
        familyId: 'f1',
        familySessionExpiresAt: new Date(),
      };
      const created = { id: 'r1', ...data };
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue(created);
      const repository = new AuthRepository(prisma);

      const result = await repository.createRefreshToken(data);

      expect(prisma.refreshToken.create).toHaveBeenCalledWith({ data });
      expect(result).toBe(created);
    });

    it('findRefreshTokenByHash mencari via tokenHash unique', async () => {
      const prisma = createMockPrisma();
      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue(null);
      const repository = new AuthRepository(prisma);

      await repository.findRefreshTokenByHash('hash1');

      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: 'hash1' },
      });
    });

    it('findRefreshTokenById mencari via id unique', async () => {
      const prisma = createMockPrisma();
      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue(null);
      const repository = new AuthRepository(prisma);

      await repository.findRefreshTokenById('r1');

      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({ where: { id: 'r1' } });
    });

    it('findActiveSessionsForUser memfilter revokedAt:null + expiresAt>now, urut createdAt desc', async () => {
      const prisma = createMockPrisma();
      const sessions = [{ id: 'r1' }];
      (prisma.refreshToken.findMany as jest.Mock).mockResolvedValue(sessions);
      const repository = new AuthRepository(prisma);

      const result = await repository.findActiveSessionsForUser('u1');

      expect(prisma.refreshToken.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', revokedAt: null, expiresAt: { gt: expect.any(Date) } },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toBe(sessions);
    });

    it('countRefreshTokensForUser menghitung SEMUA baris (status apa pun) milik user', async () => {
      const prisma = createMockPrisma();
      (prisma.refreshToken.count as jest.Mock).mockResolvedValue(3);
      const repository = new AuthRepository(prisma);

      const result = await repository.countRefreshTokensForUser('u1');

      expect(prisma.refreshToken.count).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(result).toBe(3);
    });

    describe('hasKnownDevice', () => {
      it('true kalau kombinasi userAgent+ipAddress sudah pernah tercatat', async () => {
        const prisma = createMockPrisma();
        (prisma.refreshToken.findFirst as jest.Mock).mockResolvedValue({ id: 'r1' });
        const repository = new AuthRepository(prisma);

        const result = await repository.hasKnownDevice('u1', 'Mozilla/5.0', '127.0.0.1');

        expect(prisma.refreshToken.findFirst).toHaveBeenCalledWith({
          where: { userId: 'u1', userAgent: 'Mozilla/5.0', ipAddress: '127.0.0.1' },
          select: { id: true },
        });
        expect(result).toBe(true);
      });

      it('false kalau tidak ada baris yang cocok', async () => {
        const prisma = createMockPrisma();
        (prisma.refreshToken.findFirst as jest.Mock).mockResolvedValue(null);
        const repository = new AuthRepository(prisma);

        const result = await repository.hasKnownDevice('u1', 'Mozilla/5.0', '127.0.0.1');

        expect(result).toBe(false);
      });
    });

    it('revokeRefreshToken mengisi revokedAt TANPA syarat (unconditional)', async () => {
      const prisma = createMockPrisma();
      const revoked = { id: 'r1', revokedAt: new Date() };
      (prisma.refreshToken.update as jest.Mock).mockResolvedValue(revoked);
      const repository = new AuthRepository(prisma);

      const result = await repository.revokeRefreshToken('r1');

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(result).toBe(revoked);
    });

    describe('revokeRefreshTokenIfActive', () => {
      it('true kalau updateMany benar2 meng-update baris (count>0) — race pertama yang menang', async () => {
        const prisma = createMockPrisma();
        (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        const repository = new AuthRepository(prisma);

        const result = await repository.revokeRefreshTokenIfActive('r1');

        expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
          where: { id: 'r1', revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        });
        expect(result).toBe(true);
      });

      it('false kalau count 0 (sudah direvoke request lain barusan — skenario reuse)', async () => {
        const prisma = createMockPrisma();
        (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        const repository = new AuthRepository(prisma);

        const result = await repository.revokeRefreshTokenIfActive('r1');

        expect(result).toBe(false);
      });
    });

    describe('revokeAllRefreshTokensForUser', () => {
      it('TANPA tx: memakai this.prisma langsung', async () => {
        const prisma = createMockPrisma();
        (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
        const repository = new AuthRepository(prisma);

        await repository.revokeAllRefreshTokensForUser('u1');

        expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
          where: { userId: 'u1', revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        });
      });

      it('DENGAN tx: dijalankan lewat transaction client yang dioper, bukan this.prisma', async () => {
        const prisma = createMockPrisma();
        const tx = {
          refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
        } as never;
        const repository = new AuthRepository(prisma);

        await repository.revokeAllRefreshTokensForUser('u1', tx);

        expect(
          (tx as { refreshToken: { updateMany: jest.Mock } }).refreshToken.updateMany
        ).toHaveBeenCalledWith({
          where: { userId: 'u1', revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        });
        expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      });
    });

    describe('revokeRefreshTokenFamily', () => {
      it('TANPA tx: memakai this.prisma, hanya menyentuh family ini (bukan seluruh sesi user)', async () => {
        const prisma = createMockPrisma();
        (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({ count: 3 });
        const repository = new AuthRepository(prisma);

        await repository.revokeRefreshTokenFamily('f1');

        expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
          where: { familyId: 'f1', revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        });
      });

      it('DENGAN tx: dijalankan lewat transaction client yang dioper', async () => {
        const prisma = createMockPrisma();
        const tx = {
          refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
        } as never;
        const repository = new AuthRepository(prisma);

        await repository.revokeRefreshTokenFamily('f1', tx);

        expect(
          (tx as { refreshToken: { updateMany: jest.Mock } }).refreshToken.updateMany
        ).toHaveBeenCalledWith({
          where: { familyId: 'f1', revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        });
        expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('Email Verification', () => {
    it('createEmailVerificationToken meneruskan data langsung ke prisma', async () => {
      const prisma = createMockPrisma();
      const data = { tokenHash: 'hash', userId: 'u1', expiresAt: new Date() };
      const created = { id: 'ev1', ...data };
      (prisma.emailVerificationToken.create as jest.Mock).mockResolvedValue(created);
      const repository = new AuthRepository(prisma);

      const result = await repository.createEmailVerificationToken(data);

      expect(prisma.emailVerificationToken.create).toHaveBeenCalledWith({ data });
      expect(result).toBe(created);
    });

    it('findEmailVerificationTokenByHash mencari via tokenHash unique', async () => {
      const prisma = createMockPrisma();
      (prisma.emailVerificationToken.findUnique as jest.Mock).mockResolvedValue(null);
      const repository = new AuthRepository(prisma);

      await repository.findEmailVerificationTokenByHash('hash1');

      expect(prisma.emailVerificationToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: 'hash1' },
      });
    });

    describe('deleteEmailVerificationToken', () => {
      it('TANPA tx: memakai this.prisma langsung', async () => {
        const prisma = createMockPrisma();
        (prisma.emailVerificationToken.delete as jest.Mock).mockResolvedValue({});
        const repository = new AuthRepository(prisma);

        await repository.deleteEmailVerificationToken('ev1');

        expect(prisma.emailVerificationToken.delete).toHaveBeenCalledWith({ where: { id: 'ev1' } });
      });

      it('DENGAN tx: dijalankan lewat transaction client yang dioper', async () => {
        const prisma = createMockPrisma();
        const tx = {
          emailVerificationToken: { delete: jest.fn().mockResolvedValue({}) },
        } as never;
        const repository = new AuthRepository(prisma);

        await repository.deleteEmailVerificationToken('ev1', tx);

        expect(
          (tx as { emailVerificationToken: { delete: jest.Mock } }).emailVerificationToken.delete
        ).toHaveBeenCalledWith({ where: { id: 'ev1' } });
        expect(prisma.emailVerificationToken.delete).not.toHaveBeenCalled();
      });
    });
  });

  describe('Password Reset', () => {
    it('createPasswordResetToken meneruskan data langsung ke prisma', async () => {
      const prisma = createMockPrisma();
      const data = { tokenHash: 'hash', userId: 'u1', expiresAt: new Date() };
      const created = { id: 'pr1', ...data };
      (prisma.passwordResetToken.create as jest.Mock).mockResolvedValue(created);
      const repository = new AuthRepository(prisma);

      const result = await repository.createPasswordResetToken(data);

      expect(prisma.passwordResetToken.create).toHaveBeenCalledWith({ data });
      expect(result).toBe(created);
    });

    it('findPasswordResetTokenByHash mencari via tokenHash unique', async () => {
      const prisma = createMockPrisma();
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue(null);
      const repository = new AuthRepository(prisma);

      await repository.findPasswordResetTokenByHash('hash1');

      expect(prisma.passwordResetToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: 'hash1' },
      });
    });

    describe('deletePasswordResetToken', () => {
      it('TANPA tx: memakai this.prisma langsung', async () => {
        const prisma = createMockPrisma();
        (prisma.passwordResetToken.delete as jest.Mock).mockResolvedValue({});
        const repository = new AuthRepository(prisma);

        await repository.deletePasswordResetToken('pr1');

        expect(prisma.passwordResetToken.delete).toHaveBeenCalledWith({ where: { id: 'pr1' } });
      });

      it('DENGAN tx: dijalankan lewat transaction client yang dioper', async () => {
        const prisma = createMockPrisma();
        const tx = {
          passwordResetToken: { delete: jest.fn().mockResolvedValue({}) },
        } as never;
        const repository = new AuthRepository(prisma);

        await repository.deletePasswordResetToken('pr1', tx);

        expect(
          (tx as { passwordResetToken: { delete: jest.Mock } }).passwordResetToken.delete
        ).toHaveBeenCalledWith({ where: { id: 'pr1' } });
        expect(prisma.passwordResetToken.delete).not.toHaveBeenCalled();
      });
    });

    it('deleteAllPasswordResetTokensForUser menghapus SEMUA token lama milik user (mencegah multi-link valid)', async () => {
      const prisma = createMockPrisma();
      (prisma.passwordResetToken.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
      const repository = new AuthRepository(prisma);

      await repository.deleteAllPasswordResetTokensForUser('u1');

      expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
    });
  });

  describe('OAuth Account', () => {
    it('findOAuthAccount mencari via compound unique provider_providerAccountId', async () => {
      const prisma = createMockPrisma();
      (prisma.oAuthAccount.findUnique as jest.Mock).mockResolvedValue(null);
      const repository = new AuthRepository(prisma);

      await repository.findOAuthAccount('GOOGLE', 'acc-123');

      expect(prisma.oAuthAccount.findUnique).toHaveBeenCalledWith({
        where: {
          provider_providerAccountId: { provider: 'GOOGLE', providerAccountId: 'acc-123' },
        },
      });
    });

    it('createOAuthAccount meneruskan data + provider ke prisma', async () => {
      const prisma = createMockPrisma();
      const created = { id: 'oa1', provider: 'GITHUB', providerAccountId: 'acc-456', userId: 'u1' };
      (prisma.oAuthAccount.create as jest.Mock).mockResolvedValue(created);
      const repository = new AuthRepository(prisma);

      const result = await repository.createOAuthAccount({
        provider: 'GITHUB',
        providerAccountId: 'acc-456',
        userId: 'u1',
      });

      expect(prisma.oAuthAccount.create).toHaveBeenCalledWith({
        data: { provider: 'GITHUB', providerAccountId: 'acc-456', userId: 'u1' },
      });
      expect(result).toBe(created);
    });
  });
});
