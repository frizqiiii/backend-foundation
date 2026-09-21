import type { PrismaClient } from '@prisma/client';
import { UserRepository } from './user.repository';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
    ...overrides,
  } as unknown as PrismaClient;
}

describe('UserRepository', () => {
  it('findByEmail memfilter email + deletedAt:null, TIDAK tenant-scoped meski tenant context aktif', async () => {
    const prisma = createMockPrisma();
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    const repository = new UserRepository(prisma);

    await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () =>
      repository.findByEmail('user@example.com')
    );

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: 'user@example.com', deletedAt: null },
    });
  });

  it('findById memfilter id + deletedAt:null, TIDAK tenant-scoped (dipakai jalur auth)', async () => {
    const prisma = createMockPrisma();
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    const repository = new UserRepository(prisma);

    await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () =>
      repository.findById('u1')
    );

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'u1', deletedAt: null },
    });
  });

  it('temuan T15 — findByIdIncludingDeleted TIDAK memfilter deletedAt (khusus erasure/retensi), lookup by id saja', async () => {
    const prisma = createMockPrisma();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1', deletedAt: new Date() });
    const repository = new UserRepository(prisma);

    const result = await repository.findByIdIncludingDeleted('u1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(result).toMatchObject({ id: 'u1' });
  });

  describe('findMany', () => {
    it('TANPA tenant context: where hanya deletedAt:null', async () => {
      const prisma = createMockPrisma();
      const rows = [{ id: 'u1' }];
      (prisma.$transaction as jest.Mock).mockResolvedValue([rows, 1]);
      const repository = new UserRepository(prisma);

      const result = await repository.findMany({ skip: 0, take: 10 });

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
      expect(prisma.user.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
      expect(result).toEqual({ data: rows, total: 1 });
    });

    it('DENGAN tenant context aktif: where ikut memfilter tenantId (listing admin, tenant-scoped)', async () => {
      const prisma = createMockPrisma();
      (prisma.$transaction as jest.Mock).mockResolvedValue([[], 0]);
      const repository = new UserRepository(prisma);

      await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () =>
        repository.findMany({ skip: 0, take: 10 })
      );

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, tenantId: 'tenant-1' } })
      );
    });
  });

  describe('create', () => {
    it('TANPA tenant context aktif: tenantId null', async () => {
      const prisma = createMockPrisma();
      const data = { email: 'a@b.com', name: 'A', password: 'hashed' };
      (prisma.user.create as jest.Mock).mockResolvedValue({ id: 'u1', ...data, tenantId: null });
      const repository = new UserRepository(prisma);

      await repository.create(data);

      expect(prisma.user.create).toHaveBeenCalledWith({ data: { ...data, tenantId: null } });
    });

    it('DENGAN tenant context aktif: tenantId otomatis terisi', async () => {
      const prisma = createMockPrisma();
      const data = { email: 'a@b.com', name: 'A' };
      (prisma.user.create as jest.Mock).mockResolvedValue({});
      const repository = new UserRepository(prisma);

      await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () =>
        repository.create(data)
      );

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { ...data, tenantId: 'tenant-1' },
      });
    });
  });

  describe('update', () => {
    it('TANPA tx: memakai this.prisma langsung', async () => {
      const prisma = createMockPrisma();
      const updated = { id: 'u1', password: 'new-hash' };
      (prisma.user.update as jest.Mock).mockResolvedValue(updated);
      const repository = new UserRepository(prisma);

      const result = await repository.update('u1', { password: 'new-hash' });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { password: 'new-hash' },
      });
      expect(result).toBe(updated);
    });

    it('DENGAN tx: update dijalankan lewat transaction client yang dioper, bukan this.prisma', async () => {
      const prisma = createMockPrisma();
      const tx = { user: { update: jest.fn().mockResolvedValue({ id: 'u1' }) } } as never;
      const repository = new UserRepository(prisma);

      await repository.update('u1', { password: 'new-hash' }, tx);

      expect((tx as { user: { update: jest.Mock } }).user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { password: 'new-hash' },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  it('delete melakukan soft delete (mengisi deletedAt), bukan menghapus fisik (mencegah cascade delete)', async () => {
    const prisma = createMockPrisma();
    const deleted = { id: 'u1', deletedAt: new Date() };
    (prisma.user.update as jest.Mock).mockResolvedValue(deleted);
    const repository = new UserRepository(prisma);

    const result = await repository.delete('u1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(result).toBe(deleted);
  });
});
