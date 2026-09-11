import type { PrismaClient } from '@prisma/client';
import { MfaRepository } from './mfa.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      update: jest.fn(),
    },
    mfaRecoveryCode: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
    ...overrides,
  } as unknown as PrismaClient;
}

describe('MfaRepository', () => {
  it('setPendingSecret mengisi mfaSecret TANPA mengubah mfaEnabled', async () => {
    const prisma = createMockPrisma();
    (prisma.user.update as jest.Mock).mockResolvedValue({});
    const repository = new MfaRepository(prisma);

    await repository.setPendingSecret('u1', 'enc-secret');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { mfaSecret: 'enc-secret' },
    });
  });

  it('activateMfa mengisi mfaEnabled:true dan mfaEnabledAt', async () => {
    const prisma = createMockPrisma();
    (prisma.user.update as jest.Mock).mockResolvedValue({});
    const repository = new MfaRepository(prisma);

    await repository.activateMfa('u1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { mfaEnabled: true, mfaEnabledAt: expect.any(Date) },
    });
  });

  it('disableMfa mengosongkan secret DAN menghapus recovery code dalam satu $transaction', async () => {
    const prisma = createMockPrisma();
    (prisma.$transaction as jest.Mock).mockResolvedValue([{}, { count: 3 }]);
    const repository = new MfaRepository(prisma);

    await repository.disableMfa('u1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { mfaEnabled: false, mfaSecret: null, mfaEnabledAt: null },
    });
    expect(prisma.mfaRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('replaceRecoveryCodes menghapus kode lama lalu membuat kode baru dalam satu $transaction', async () => {
    const prisma = createMockPrisma();
    (prisma.$transaction as jest.Mock).mockResolvedValue([{ count: 5 }, { count: 3 }]);
    const repository = new MfaRepository(prisma);

    await repository.replaceRecoveryCodes('u1', ['hash1', 'hash2', 'hash3']);

    expect(prisma.mfaRecoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.mfaRecoveryCode.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'u1', codeHash: 'hash1' },
        { userId: 'u1', codeHash: 'hash2' },
        { userId: 'u1', codeHash: 'hash3' },
      ],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('findUnusedRecoveryCodes memfilter userId + usedAt:null', async () => {
    const prisma = createMockPrisma();
    const codes = [{ id: 'c1' }];
    (prisma.mfaRecoveryCode.findMany as jest.Mock).mockResolvedValue(codes);
    const repository = new MfaRepository(prisma);

    const result = await repository.findUnusedRecoveryCodes('u1');

    expect(prisma.mfaRecoveryCode.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', usedAt: null },
    });
    expect(result).toBe(codes);
  });

  it('markRecoveryCodeUsed mengisi usedAt dengan Date sekarang', async () => {
    const prisma = createMockPrisma();
    (prisma.mfaRecoveryCode.update as jest.Mock).mockResolvedValue({});
    const repository = new MfaRepository(prisma);

    await repository.markRecoveryCodeUsed('c1');

    expect(prisma.mfaRecoveryCode.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { usedAt: expect.any(Date) },
    });
  });
});
