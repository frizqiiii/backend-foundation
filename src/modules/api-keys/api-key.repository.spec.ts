import type { Prisma, PrismaClient } from '@prisma/client';
import { ApiKeyRepository } from './api-key.repository';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

/**
 * R17 (RLS) — `findByHash`/`touchLastUsed` berjalan di transaksi bypass (`withRlsBypass`): `$transaction` dipanggil
 * dengan callback yang menerima `tx`. Mock ini menjalankan callback itu dengan `tx` tiruan dan mencatat bahwa
 * `app.bypass_rls` di-set di transaksi yang sama.
 */
function createBypassMockPrisma() {
  const tx = {
    apiKey: { findUnique: jest.fn(), update: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = createMockPrisma({
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  });
  return { prisma, tx };
}

describe('ApiKeyRepository', () => {
  const baseData = {
    userId: 'u1',
    tenantId: null,
    name: 'CI key',
    keyPrefix: 'ak_live',
    keyHash: 'hashed',
    scopes: ['read'],
    expiresAt: null,
  };

  it('create meneruskan data langsung ke prisma.apiKey.create', async () => {
    const prisma = createMockPrisma();
    const created = { id: 'k1', ...baseData };
    (prisma.apiKey.create as jest.Mock).mockResolvedValue(created);
    const repository = new ApiKeyRepository(prisma);

    const result = await repository.create(baseData);

    expect(prisma.apiKey.create).toHaveBeenCalledWith({ data: baseData });
    expect(result).toBe(created);
  });

  it('findByHash mencari berdasarkan keyHash TANPA memfilter revokedAt/expiresAt, di transaksi bypass RLS', async () => {
    const { prisma, tx } = createBypassMockPrisma();
    tx.apiKey.findUnique.mockResolvedValue(null);
    const repository = new ApiKeyRepository(prisma);

    const result = await repository.findByHash('some-hash');

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.apiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: 'some-hash' } });
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('findManyForUser mengambil semua key milik user, urut createdAt desc', async () => {
    const prisma = createMockPrisma();
    const keys = [{ id: 'k1' }, { id: 'k2' }];
    (prisma.apiKey.findMany as jest.Mock).mockResolvedValue(keys);
    const repository = new ApiKeyRepository(prisma);

    const result = await repository.findManyForUser('u1');

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toBe(keys);
  });

  it('findByIdForUser mencari key spesifik yang dimiliki user tersebut (scoped)', async () => {
    const prisma = createMockPrisma();
    (prisma.apiKey.findFirst as jest.Mock).mockResolvedValue(null);
    const repository = new ApiKeyRepository(prisma);

    await repository.findByIdForUser('k1', 'u1');

    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({ where: { id: 'k1', userId: 'u1' } });
  });

  it('T4 — findById mencari LINTAS user (TIDAK di-scope), beda dari findByIdForUser', async () => {
    const prisma = createMockPrisma();
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    const repository = new ApiKeyRepository(prisma);

    await repository.findById('k1');

    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({ where: { id: 'k1' } });
  });

  it('T4 — updateRateLimitOverride menyimpan angka override', async () => {
    const prisma = createMockPrisma();
    const updated = { id: 'k1', rateLimitOverridePerMinute: 500 };
    (prisma.apiKey.update as jest.Mock).mockResolvedValue(updated);
    const repository = new ApiKeyRepository(prisma);

    const result = await repository.updateRateLimitOverride('k1', 500);

    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { rateLimitOverridePerMinute: 500 },
    });
    expect(result).toBe(updated);
  });

  it('T4 — updateRateLimitOverride(id, null) MENGHAPUS override, bukan diabaikan', async () => {
    const prisma = createMockPrisma();
    const updated = { id: 'k1', rateLimitOverridePerMinute: null };
    (prisma.apiKey.update as jest.Mock).mockResolvedValue(updated);
    const repository = new ApiKeyRepository(prisma);

    await repository.updateRateLimitOverride('k1', null);

    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { rateLimitOverridePerMinute: null },
    });
  });

  it('revoke mengisi revokedAt dengan Date sekarang', async () => {
    const prisma = createMockPrisma();
    const revoked = { id: 'k1', revokedAt: new Date() };
    (prisma.apiKey.update as jest.Mock).mockResolvedValue(revoked);
    const repository = new ApiKeyRepository(prisma);

    const result = await repository.revoke('k1');

    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(result).toBe(revoked);
  });

  it('touchLastUsed mengisi lastUsedAt dan tidak mengembalikan apa pun, di transaksi bypass RLS', async () => {
    const { prisma, tx } = createBypassMockPrisma();
    tx.apiKey.update.mockResolvedValue({});
    const repository = new ApiKeyRepository(prisma);

    const result = await repository.touchLastUsed('k1');

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { lastUsedAt: expect.any(Date) },
    });
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  // R17 (RLS) — dengan tenant context aktif, method yang berjalan di request bertenant HARUS memakai transaction
  // client (`tx`) yang sudah membawa `app.tenant_id`; memakai `this.prisma` ditolak/disembunyikan FORCE RLS.
  describe('DENGAN transaction client tenant (RLS): memakai tx, BUKAN this.prisma', () => {
    function createMockTx() {
      return {
        apiKey: {
          create: jest.fn(),
          findMany: jest.fn(),
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
    }

    function withTx<T>(tx: ReturnType<typeof createMockTx>, fn: () => T): T {
      return runWithTenantContext(
        { tenantId: 'tenant-1', tenantSlug: 'acme', db: tx as unknown as Prisma.TransactionClient },
        fn
      );
    }

    function expectPrismaUntouched(prisma: PrismaClient) {
      expect(prisma.apiKey.create).not.toHaveBeenCalled();
      expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
      expect(prisma.apiKey.findFirst).not.toHaveBeenCalled();
      expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
      expect(prisma.apiKey.update).not.toHaveBeenCalled();
    }

    it('create: lewat tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.apiKey.create.mockResolvedValue({ id: 'k1' });

      await withTx(tx, () =>
        new ApiKeyRepository(prisma).create({ ...baseData, tenantId: 'tenant-1' })
      );

      expect(tx.apiKey.create).toHaveBeenCalledWith({
        data: { ...baseData, tenantId: 'tenant-1' },
      });
      expectPrismaUntouched(prisma);
    });

    it('findManyForUser: lewat tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.apiKey.findMany.mockResolvedValue([]);

      await withTx(tx, () => new ApiKeyRepository(prisma).findManyForUser('u1'));

      expect(tx.apiKey.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'desc' },
      });
      expectPrismaUntouched(prisma);
    });

    it('findByIdForUser: lewat tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.apiKey.findFirst.mockResolvedValue(null);

      await withTx(tx, () => new ApiKeyRepository(prisma).findByIdForUser('k1', 'u1'));

      expect(tx.apiKey.findFirst).toHaveBeenCalledWith({ where: { id: 'k1', userId: 'u1' } });
      expectPrismaUntouched(prisma);
    });

    it('findById: lewat tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.apiKey.findUnique.mockResolvedValue(null);

      await withTx(tx, () => new ApiKeyRepository(prisma).findById('k1'));

      expect(tx.apiKey.findUnique).toHaveBeenCalledWith({ where: { id: 'k1' } });
      expectPrismaUntouched(prisma);
    });

    it('updateRateLimitOverride: lewat tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.apiKey.update.mockResolvedValue({ id: 'k1' });

      await withTx(tx, () => new ApiKeyRepository(prisma).updateRateLimitOverride('k1', 500));

      expect(tx.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'k1' },
        data: { rateLimitOverridePerMinute: 500 },
      });
      expectPrismaUntouched(prisma);
    });

    it('revoke: lewat tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.apiKey.update.mockResolvedValue({ id: 'k1' });

      await withTx(tx, () => new ApiKeyRepository(prisma).revoke('k1'));

      expect(tx.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'k1' },
        data: { revokedAt: expect.any(Date) },
      });
      expectPrismaUntouched(prisma);
    });

    it('findByHash TETAP bypass (bukan tx tenant) walau tenant context aktif — tenant belum diketahui saat autentikasi', async () => {
      const { prisma, tx: bypassTx } = createBypassMockPrisma();
      bypassTx.apiKey.findUnique.mockResolvedValue(null);
      const tenantTx = createMockTx();

      await withTx(tenantTx, () => new ApiKeyRepository(prisma).findByHash('h'));

      expect(bypassTx.apiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: 'h' } });
      expect(tenantTx.apiKey.findUnique).not.toHaveBeenCalled();
    });
  });
});
