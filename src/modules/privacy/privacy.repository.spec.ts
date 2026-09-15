import type { PrismaClient } from '@prisma/client';
import { PrivacyRepository } from './privacy.repository';

function createMockPrisma() {
  const tx = {
    user: { update: jest.fn() },
    oAuthAccount: { deleteMany: jest.fn() },
    ssoIdentity: { deleteMany: jest.fn() },
    refreshToken: { deleteMany: jest.fn() },
    mfaRecoveryCode: { deleteMany: jest.fn() },
    emailVerificationToken: { deleteMany: jest.fn() },
    passwordResetToken: { deleteMany: jest.fn() },
    apiKey: { deleteMany: jest.fn() },
    fileUpload: { deleteMany: jest.fn() },
  };
  return {
    $transaction: jest.fn((callback: (t: typeof tx) => unknown) => callback(tx)),
    __tx: tx,
  } as unknown as PrismaClient & { __tx: typeof tx };
}

describe('PrivacyRepository', () => {
  it('eraseUserData men-scrub field PII user & menghapus SEMUA tabel terkait, dalam SATU transaksi', async () => {
    const prisma = createMockPrisma();
    prisma.__tx.user.update.mockResolvedValue({ id: 'u1', erasedAt: new Date() });
    const repository = new PrivacyRepository(prisma);

    await repository.eraseUserData('u1');

    const updateArgs = prisma.__tx.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'u1' });
    expect(updateArgs.data.email).toBe('erased-u1@erased.invalid');
    expect(updateArgs.data.name).toBe('Deleted User');
    expect(updateArgs.data.password).toBeNull();
    expect(updateArgs.data.mfaSecret).toBeNull();
    expect(updateArgs.data.mfaEnabled).toBe(false);
    expect(updateArgs.data.erasedAt).toBeInstanceOf(Date);
    expect(updateArgs.data.deletedAt).toBeInstanceOf(Date);

    for (const table of [
      'oAuthAccount',
      'ssoIdentity',
      'refreshToken',
      'mfaRecoveryCode',
      'emailVerificationToken',
      'passwordResetToken',
      'apiKey',
      'fileUpload',
    ] as const) {
      expect(prisma.__tx[table].deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    }

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('placeholder email DETERMINISTIK dari userId — dua panggilan untuk userId berbeda menghasilkan email berbeda (tidak pernah tabrakan unique constraint)', async () => {
    const prismaA = createMockPrisma();
    prismaA.__tx.user.update.mockResolvedValue({ id: 'user-a' });
    const prismaB = createMockPrisma();
    prismaB.__tx.user.update.mockResolvedValue({ id: 'user-b' });

    await new PrivacyRepository(prismaA).eraseUserData('user-a');
    await new PrivacyRepository(prismaB).eraseUserData('user-b');

    const emailA = prismaA.__tx.user.update.mock.calls[0][0].data.email;
    const emailB = prismaB.__tx.user.update.mock.calls[0][0].data.email;
    expect(emailA).not.toBe(emailB);
  });
});
