import type { PrismaClient } from '@prisma/client';
import { ApiKeyRepository } from './api-key.repository';

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

  it('findByHash mencari berdasarkan keyHash TANPA memfilter revokedAt/expiresAt', async () => {
    const prisma = createMockPrisma();
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    const repository = new ApiKeyRepository(prisma);

    const result = await repository.findByHash('some-hash');

    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: 'some-hash' } });
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

  it('touchLastUsed mengisi lastUsedAt dan tidak mengembalikan apa pun', async () => {
    const prisma = createMockPrisma();
    (prisma.apiKey.update as jest.Mock).mockResolvedValue({});
    const repository = new ApiKeyRepository(prisma);

    const result = await repository.touchLastUsed('k1');

    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { lastUsedAt: expect.any(Date) },
    });
    expect(result).toBeUndefined();
  });
});
