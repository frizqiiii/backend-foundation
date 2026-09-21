import type { PrismaClient } from '@prisma/client';
import { PrivacyRepository } from './privacy.repository';

const CHILD_TABLES = [
  'oAuthAccount',
  'ssoIdentity',
  'refreshToken',
  'mfaRecoveryCode',
  'emailVerificationToken',
  'passwordResetToken',
  'apiKey',
  'fileUpload',
] as const;

function createMockPrisma() {
  const childTable = () => ({
    deleteMany: jest.fn(),
    // Temuan T15 — pengaman "gagal keras" menghitung sisa baris sesudah dihapus; default 0 = bersih.
    count: jest.fn().mockResolvedValue(0),
  });
  const tx = {
    // `withRlsBypass` menjalankan `SELECT set_config('app.bypass_rls', 'on', true)` lebih dulu.
    $executeRaw: jest.fn(),
    user: { update: jest.fn() },
    oAuthAccount: childTable(),
    ssoIdentity: childTable(),
    refreshToken: childTable(),
    mfaRecoveryCode: childTable(),
    emailVerificationToken: childTable(),
    passwordResetToken: childTable(),
    apiKey: childTable(),
    fileUpload: childTable(),
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
  describe('temuan T15 — erasure harus benar-benar tuntas di bawah FORCE RLS', () => {
    it('bypass RLS di-set di transaksi yang SAMA dan SEBELUM operasi tulis apa pun (tanpa itu deleteMany pada api_keys menghapus 0 baris secara diam-diam)', async () => {
      const prisma = createMockPrisma();
      prisma.__tx.user.update.mockResolvedValue({ id: 'u1', erasedAt: new Date() });
      const repository = new PrivacyRepository(prisma);

      await repository.eraseUserData('u1');

      // Satu transaksi, dan set_config('app.bypass_rls', 'on', true) dipanggil di dalamnya.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.__tx.$executeRaw).toHaveBeenCalledTimes(1);
      const [templateStrings] = prisma.__tx.$executeRaw.mock.calls[0] as [TemplateStringsArray];
      expect(templateStrings.join('')).toContain('app.bypass_rls');
      expect(templateStrings.join('')).toContain("'on'");

      const bypassOrder = prisma.__tx.$executeRaw.mock.invocationCallOrder[0];
      expect(bypassOrder).toBeLessThan(prisma.__tx.user.update.mock.invocationCallOrder[0]);
      for (const table of CHILD_TABLES) {
        expect(bypassOrder).toBeLessThan(prisma.__tx[table].deleteMany.mock.invocationCallOrder[0]);
      }
    });

    it.each(CHILD_TABLES)(
      'kalau %s MASIH punya baris sesudah dihapus -> lempar error (transaksi dibatalkan), erasure TIDAK dianggap berhasil',
      async (table) => {
        const prisma = createMockPrisma();
        prisma.__tx.user.update.mockResolvedValue({ id: 'u1', erasedAt: new Date() });
        prisma.__tx[table].count.mockResolvedValue(2);
        const repository = new PrivacyRepository(prisma);

        await expect(repository.eraseUserData('u1')).rejects.toThrow(
          new RegExp(`erasure tidak tuntas.*${table} \\(2\\)`)
        );
      }
    );

    it('semua tabel bersih -> berhasil dan mengembalikan user yang sudah di-scrub', async () => {
      const prisma = createMockPrisma();
      const erased = { id: 'u1', erasedAt: new Date() };
      prisma.__tx.user.update.mockResolvedValue(erased);

      await expect(new PrivacyRepository(prisma).eraseUserData('u1')).resolves.toBe(erased);
    });

    it('error dari salah satu langkah merambat keluar (rollback ditangani $transaction), bukan ditelan', async () => {
      const prisma = createMockPrisma();
      prisma.__tx.user.update.mockResolvedValue({ id: 'u1', erasedAt: new Date() });
      prisma.__tx.apiKey.deleteMany.mockRejectedValue(new Error('koneksi putus'));

      await expect(new PrivacyRepository(prisma).eraseUserData('u1')).rejects.toThrow(
        'koneksi putus'
      );
    });
  });
});
