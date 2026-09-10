jest.mock('../../config/database', () => ({
  prisma: {
    refreshToken: { deleteMany: jest.fn() },
    blacklistedToken: { deleteMany: jest.fn() },
    emailVerificationToken: { deleteMany: jest.fn() },
    passwordResetToken: { deleteMany: jest.fn() },
  },
}));

import { prisma } from '../../config/database';
import { cleanupExpiredRefreshTokensJob } from './cleanup-expired-refresh-tokens.job';
import { cleanupExpiredBlacklistedTokensJob } from './cleanup-expired-blacklisted-tokens.job';
import { cleanupExpiredAuthTokensJob } from './cleanup-expired-auth-tokens.job';

describe('cleanupExpiredRefreshTokensJob', () => {
  it('menghapus refresh token yang `expiresAt` ATAU `familySessionExpiresAt`-nya sudah lewat (Finding #20), dan melaporkan jumlahnya', async () => {
    (prisma.refreshToken.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 7 });

    const summary = await cleanupExpiredRefreshTokensJob.run();

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { expiresAt: { lt: expect.any(Date) } },
          { familySessionExpiresAt: { lt: expect.any(Date) } },
        ],
      },
    });
    expect(summary.message).toContain('7');
    expect(summary.details).toEqual({ deletedCount: 7 });
  });
});

describe('cleanupExpiredBlacklistedTokensJob', () => {
  it('menghapus blacklisted token yang sudah lewat expiresAt', async () => {
    (prisma.blacklistedToken.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 3 });

    const summary = await cleanupExpiredBlacklistedTokensJob.run();

    expect(prisma.blacklistedToken.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
    expect(summary.details).toEqual({ deletedCount: 3 });
  });
});

describe('cleanupExpiredAuthTokensJob', () => {
  it('menghapus email verification token DAN password reset token yang kedaluwarsa secara paralel', async () => {
    (prisma.emailVerificationToken.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 2 });
    (prisma.passwordResetToken.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 5 });

    const summary = await cleanupExpiredAuthTokensJob.run();

    expect(summary.details).toEqual({
      emailVerificationTokensDeleted: 2,
      passwordResetTokensDeleted: 5,
    });
    expect(summary.message).toContain('7');
  });
});
