import type { PrismaClient } from '@prisma/client';
import { ProductRepository } from './product.repository';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import type { ListProductsQueryDto } from './product.dto';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    product: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    productUpgradeLog: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    ...overrides,
  } as unknown as PrismaClient;
}

const baseProductData = {
  title: 'Kaos',
  description: 'Kaos katun',
  price: 100000,
  stock: 10,
  userId: 'u1',
};

describe('ProductRepository', () => {
  describe('create', () => {
    it('TANPA tenant context aktif: tenantId null', async () => {
      const prisma = createMockPrisma();
      const created = { id: 'p1', ...baseProductData, tenantId: null };
      (prisma.product.create as jest.Mock).mockResolvedValue(created);
      const repository = new ProductRepository(prisma);

      const result = await repository.create(baseProductData);

      expect(prisma.product.create).toHaveBeenCalledWith({
        data: { ...baseProductData, tenantId: null },
      });
      expect(result).toBe(created);
    });

    it('DENGAN tenant context aktif: tenantId otomatis terisi', async () => {
      const prisma = createMockPrisma();
      (prisma.product.create as jest.Mock).mockResolvedValue({});
      const repository = new ProductRepository(prisma);

      await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme' }, () =>
        repository.create(baseProductData)
      );

      expect(prisma.product.create).toHaveBeenCalledWith({
        data: { ...baseProductData, tenantId: 'tenant-1' },
      });
    });
  });

  describe('findMany', () => {
    it('default hanya filter deletedAt:null, pakai prismaRead (default = prisma primary)', async () => {
      const prisma = createMockPrisma();
      const rows = [{ id: 'p1' }];
      (prisma.$transaction as jest.Mock).mockResolvedValue([rows, 1]);
      const repository = new ProductRepository(prisma);

      const result = await repository.findMany({ page: 1, limit: 10 } as ListProductsQueryDto);

      expect(prisma.product.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
      expect(prisma.product.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
      expect(result).toEqual({ data: rows, total: 1 });
    });

    it('memakai instance prismaRead terpisah kalau dioper eksplisit di constructor', async () => {
      const primary = createMockPrisma();
      const replica = createMockPrisma();
      (replica.$transaction as jest.Mock).mockResolvedValue([[], 0]);
      const repository = new ProductRepository(primary, replica);

      await repository.findMany({ page: 1, limit: 10 } as ListProductsQueryDto);

      expect(replica.product.findMany).toHaveBeenCalled();
      expect(primary.product.findMany).not.toHaveBeenCalled();
    });

    it('menambahkan filter status dan category kalau diisi di query', async () => {
      const prisma = createMockPrisma();
      (prisma.$transaction as jest.Mock).mockResolvedValue([[], 0]);
      const repository = new ProductRepository(prisma);

      await repository.findMany({
        page: 1,
        limit: 10,
        status: 'ACTIVE',
        category: 'PREMIUM',
      } as ListProductsQueryDto);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, status: 'ACTIVE', category: 'PREMIUM' },
        })
      );
    });

    it('DENGAN tenant context aktif: where ikut memfilter tenantId', async () => {
      const prisma = createMockPrisma();
      (prisma.$transaction as jest.Mock).mockResolvedValue([[], 0]);
      const repository = new ProductRepository(prisma);

      await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme' }, () =>
        repository.findMany({ page: 1, limit: 10 } as ListProductsQueryDto)
      );

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, tenantId: 'tenant-1' } })
      );
    });
  });

  describe('findById', () => {
    it('TANPA tenant context: where hanya id + deletedAt:null', async () => {
      const prisma = createMockPrisma();
      (prisma.product.findFirst as jest.Mock).mockResolvedValue(null);
      const repository = new ProductRepository(prisma);

      await repository.findById('p1');

      expect(prisma.product.findFirst).toHaveBeenCalledWith({
        where: { id: 'p1', deletedAt: null },
      });
    });

    it('DENGAN tenant context aktif: where ikut memfilter tenantId', async () => {
      const prisma = createMockPrisma();
      (prisma.product.findFirst as jest.Mock).mockResolvedValue(null);
      const repository = new ProductRepository(prisma);

      await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme' }, () =>
        repository.findById('p1')
      );

      expect(prisma.product.findFirst).toHaveBeenCalledWith({
        where: { id: 'p1', deletedAt: null, tenantId: 'tenant-1' },
      });
    });
  });

  it('applyUpgrade meng-update category DAN mencatat productUpgradeLog dalam satu $transaction', async () => {
    const prisma = createMockPrisma();
    const updatedProduct = { id: 'p1', category: 'PREMIUM' };
    (prisma.$transaction as jest.Mock).mockResolvedValue([updatedProduct, { id: 'log1' }]);
    const repository = new ProductRepository(prisma);

    const result = await repository.applyUpgrade({
      productId: 'p1',
      fromCategory: 'STANDARD' as never,
      toCategory: 'PREMIUM' as never,
      performedById: 'admin1',
    });

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { category: 'PREMIUM' },
    });
    expect(prisma.productUpgradeLog.create).toHaveBeenCalledWith({
      data: {
        productId: 'p1',
        fromCategory: 'STANDARD',
        toCategory: 'PREMIUM',
        performedById: 'admin1',
      },
    });
    expect(result).toBe(updatedProduct);
  });

  it('delete melakukan soft delete (mengisi deletedAt), bukan menghapus fisik', async () => {
    const prisma = createMockPrisma();
    const deleted = { id: 'p1', deletedAt: new Date() };
    (prisma.product.update as jest.Mock).mockResolvedValue(deleted);
    const repository = new ProductRepository(prisma);

    const result = await repository.delete('p1');

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(result).toBe(deleted);
  });
});
