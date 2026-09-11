import type { PrismaClient } from '@prisma/client';
import { FeatureFlagRepository } from './feature-flag.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    featureFlag: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('FeatureFlagRepository', () => {
  it('findAll mengambil semua flag terurut asc berdasarkan key', async () => {
    const prisma = createMockPrisma();
    const flags = [{ key: 'a' }, { key: 'b' }];
    (prisma.featureFlag.findMany as jest.Mock).mockResolvedValue(flags);
    const repository = new FeatureFlagRepository(prisma);

    const result = await repository.findAll();

    expect(prisma.featureFlag.findMany).toHaveBeenCalledWith({ orderBy: { key: 'asc' } });
    expect(result).toBe(flags);
  });

  it('findByKey mengembalikan flag berdasarkan key, null kalau tidak ada', async () => {
    const prisma = createMockPrisma();
    (prisma.featureFlag.findUnique as jest.Mock).mockResolvedValue(null);
    const repository = new FeatureFlagRepository(prisma);

    const result = await repository.findByKey('non-existent');

    expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({
      where: { key: 'non-existent' },
    });
    expect(result).toBeNull();
  });

  it('upsert membuat flag baru dengan create data lengkap dan update data parsial', async () => {
    const prisma = createMockPrisma();
    const data = { enabled: true, description: 'test flag' };
    const upserted = { key: 'my-flag', ...data };
    (prisma.featureFlag.upsert as jest.Mock).mockResolvedValue(upserted);
    const repository = new FeatureFlagRepository(prisma);

    const result = await repository.upsert('my-flag', data);

    expect(prisma.featureFlag.upsert).toHaveBeenCalledWith({
      where: { key: 'my-flag' },
      create: { key: 'my-flag', ...data },
      update: data,
    });
    expect(result).toBe(upserted);
  });
});
