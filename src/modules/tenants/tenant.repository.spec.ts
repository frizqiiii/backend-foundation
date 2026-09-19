import type { PrismaClient } from '@prisma/client';
import { TenantRepository } from './tenant.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    tenant: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
    ...overrides,
  } as unknown as PrismaClient;
}

describe('TenantRepository', () => {
  it('findBySlug memakai findFirst dengan filter slug + deletedAt:null', async () => {
    const prisma = createMockPrisma();
    (prisma.tenant.findFirst as jest.Mock).mockResolvedValue(null);
    const repository = new TenantRepository(prisma);

    await repository.findBySlug('acme');

    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { slug: 'acme', deletedAt: null },
    });
  });

  it('findById memakai findFirst dengan filter id + deletedAt:null (tenant soft-deleted tidak resolvable)', async () => {
    const prisma = createMockPrisma();
    (prisma.tenant.findFirst as jest.Mock).mockResolvedValue(null);
    const repository = new TenantRepository(prisma);

    await repository.findById('t1');

    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { id: 't1', deletedAt: null },
    });
  });

  it('findMany membungkus findMany+count dalam $transaction agar total sinkron dengan data', async () => {
    const prisma = createMockPrisma();
    const rows = [{ id: 't1' }, { id: 't2' }];
    (prisma.$transaction as jest.Mock).mockResolvedValue([rows, 2]);
    const repository = new TenantRepository(prisma);

    const result = await repository.findMany({ skip: 0, take: 10 });

    expect(prisma.tenant.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      skip: 0,
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.tenant.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: rows, total: 2 });
  });

  it('create meneruskan slug+name langsung ke prisma.tenant.create', async () => {
    const prisma = createMockPrisma();
    const created = { id: 't1', slug: 'acme', name: 'Acme' };
    (prisma.tenant.create as jest.Mock).mockResolvedValue(created);
    const repository = new TenantRepository(prisma);

    const result = await repository.create({ slug: 'acme', name: 'Acme' });

    expect(prisma.tenant.create).toHaveBeenCalledWith({ data: { slug: 'acme', name: 'Acme' } });
    expect(result).toBe(created);
  });

  it('item 2.11 — create meneruskan `plan` kalau diisi', async () => {
    const prisma = createMockPrisma();
    (prisma.tenant.create as jest.Mock).mockResolvedValue({ id: 't1' });
    const repository = new TenantRepository(prisma);

    await repository.create({ slug: 'acme', name: 'Acme', plan: 'FREE' });

    expect(prisma.tenant.create).toHaveBeenCalledWith({
      data: { slug: 'acme', name: 'Acme', plan: 'FREE' },
    });
  });

  it('item 2.11 — updatePlan HANYA menulis kolom plan (bukan status/slug/name)', async () => {
    const prisma = createMockPrisma();
    const updated = { id: 't1', plan: 'ENTERPRISE' };
    (prisma.tenant.update as jest.Mock).mockResolvedValue(updated);
    const repository = new TenantRepository(prisma);

    const result = await repository.updatePlan('t1', 'ENTERPRISE');

    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { plan: 'ENTERPRISE' },
    });
    expect(result).toBe(updated);
  });

  it('softDelete mengisi deletedAt, TIDAK menghapus row secara fisik', async () => {
    const prisma = createMockPrisma();
    const updated = { id: 't1', deletedAt: new Date() };
    (prisma.tenant.update as jest.Mock).mockResolvedValue(updated);
    const repository = new TenantRepository(prisma);

    const result = await repository.softDelete('t1');

    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(result).toBe(updated);
  });
});
