import type { Prisma, PrismaClient } from '@prisma/client';
import { EventRepository, type CreateEventData } from './event.repository';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import type { ListEventsQueryDto } from './event.dto';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
    ...overrides,
  } as unknown as PrismaClient;
}

const baseEventData: CreateEventData = {
  title: 'Konser',
  category: 'Musik',
  location: 'Jakarta',
  date: new Date('2026-12-01'),
  ownerId: 'u1',
};

describe('EventRepository', () => {
  describe('create', () => {
    it('TANPA tenant context aktif: tenantId null', async () => {
      const prisma = createMockPrisma();
      const created = { id: 'e1', ...baseEventData, tenantId: null };
      (prisma.event.create as jest.Mock).mockResolvedValue(created);
      const repository = new EventRepository(prisma);

      const result = await repository.create(baseEventData);

      expect(prisma.event.create).toHaveBeenCalledWith({
        data: { ...baseEventData, tenantId: null },
      });
      expect(result).toBe(created);
    });

    it('DENGAN tenant context aktif: tenantId otomatis terisi dari context', async () => {
      const prisma = createMockPrisma();
      (prisma.event.create as jest.Mock).mockResolvedValue({});
      const repository = new EventRepository(prisma);

      await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () =>
        repository.create(baseEventData)
      );

      expect(prisma.event.create).toHaveBeenCalledWith({
        data: { ...baseEventData, tenantId: 'tenant-1' },
      });
    });
  });

  describe('findMany', () => {
    it('membangun where dari search/category/location/dateFrom/dateTo dan membungkusnya di $transaction', async () => {
      const prisma = createMockPrisma();
      const rows = [{ id: 'e1' }];
      (prisma.$transaction as jest.Mock).mockResolvedValue([rows, 1]);
      const repository = new EventRepository(prisma);

      const query: ListEventsQueryDto = {
        page: 1,
        limit: 10,
        search: 'konser',
        category: 'Musik',
        location: 'Jakarta',
        dateFrom: new Date('2026-01-01'),
        dateTo: new Date('2026-12-31'),
      } as ListEventsQueryDto;

      const result = await repository.findMany(query);

      expect(prisma.event.findMany).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          title: { contains: 'konser', mode: 'insensitive' },
          category: 'Musik',
          location: { contains: 'Jakarta', mode: 'insensitive' },
          date: { gte: query.dateFrom, lte: query.dateTo },
        },
        skip: 0,
        take: 10,
        orderBy: { date: 'asc' },
      });
      expect(prisma.event.count).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          title: { contains: 'konser', mode: 'insensitive' },
          category: 'Musik',
          location: { contains: 'Jakarta', mode: 'insensitive' },
          date: { gte: query.dateFrom, lte: query.dateTo },
        },
      });
      expect(result).toEqual({ data: rows, total: 1 });
    });

    it('tanpa filter opsional: where hanya berisi deletedAt:null', async () => {
      const prisma = createMockPrisma();
      (prisma.$transaction as jest.Mock).mockResolvedValue([[], 0]);
      const repository = new EventRepository(prisma);

      await repository.findMany({ page: 1, limit: 10 } as ListEventsQueryDto);

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } })
      );
    });

    it('DENGAN tenant context aktif: where ikut memfilter tenantId', async () => {
      const prisma = createMockPrisma();
      (prisma.$transaction as jest.Mock).mockResolvedValue([[], 0]);
      const repository = new EventRepository(prisma);

      await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () =>
        repository.findMany({ page: 1, limit: 10 } as ListEventsQueryDto)
      );

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, tenantId: 'tenant-1' } })
      );
    });
  });

  describe('findById', () => {
    it('TANPA tenant context: where hanya id + deletedAt:null', async () => {
      const prisma = createMockPrisma();
      (prisma.event.findFirst as jest.Mock).mockResolvedValue(null);
      const repository = new EventRepository(prisma);

      await repository.findById('e1');

      expect(prisma.event.findFirst).toHaveBeenCalledWith({
        where: { id: 'e1', deletedAt: null },
      });
    });

    it('DENGAN tenant context aktif: where ikut memfilter tenantId (mencegah akses lintas tenant)', async () => {
      const prisma = createMockPrisma();
      (prisma.event.findFirst as jest.Mock).mockResolvedValue(null);
      const repository = new EventRepository(prisma);

      await runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () =>
        repository.findById('e1')
      );

      expect(prisma.event.findFirst).toHaveBeenCalledWith({
        where: { id: 'e1', deletedAt: null, tenantId: 'tenant-1' },
      });
    });
  });

  it('update meneruskan data parsial langsung ke prisma.event.update', async () => {
    const prisma = createMockPrisma();
    const updated = { id: 'e1', title: 'Baru' };
    (prisma.event.update as jest.Mock).mockResolvedValue(updated);
    const repository = new EventRepository(prisma);

    const result = await repository.update('e1', { title: 'Baru' });

    expect(prisma.event.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { title: 'Baru' },
    });
    expect(result).toBe(updated);
  });

  it('delete melakukan soft delete (mengisi deletedAt), bukan menghapus fisik', async () => {
    const prisma = createMockPrisma();
    const deleted = { id: 'e1', deletedAt: new Date() };
    (prisma.event.update as jest.Mock).mockResolvedValue(deleted);
    const repository = new EventRepository(prisma);

    const result = await repository.delete('e1');

    expect(prisma.event.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(result).toBe(deleted);
  });

  // R16 (RLS) — saat tenant context aktif, `tenantMiddleware` menyediakan transaction client (`tx`) yang sudah
  // membawa `app.tenant_id`. SEMUA method harus memakai `tx` itu; memakai `this.prisma` membuat query berjalan
  // di koneksi lain TANPA `app.tenant_id` sehingga ditolak/disembunyikan FORCE RLS (create -> 42501, list -> kosong).
  describe('DENGAN transaction client tenant (RLS): memakai tx, BUKAN this.prisma', () => {
    function createMockTx() {
      return {
        event: {
          create: jest.fn(),
          findMany: jest.fn(),
          count: jest.fn(),
          findFirst: jest.fn(),
          update: jest.fn(),
        },
      };
    }

    function withTx<T>(tx: ReturnType<typeof createMockTx>, fn: () => T): T {
      return runWithTenantContext(
        {
          tenantId: 'tenant-1',
          tenantSlug: 'acme',
          db: tx as unknown as Prisma.TransactionClient,
        },
        fn
      );
    }

    function expectPrismaUntouched(prisma: PrismaClient) {
      expect(prisma.event.create).not.toHaveBeenCalled();
      expect(prisma.event.findMany).not.toHaveBeenCalled();
      expect(prisma.event.count).not.toHaveBeenCalled();
      expect(prisma.event.findFirst).not.toHaveBeenCalled();
      expect(prisma.event.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }

    it('create: lewat tx dengan tenantId dari context', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.event.create.mockResolvedValue({ id: 'e1' });

      await withTx(tx, () => new EventRepository(prisma).create(baseEventData));

      expect(tx.event.create).toHaveBeenCalledWith({
        data: { ...baseEventData, tenantId: 'tenant-1' },
      });
      expectPrismaUntouched(prisma);
    });

    it('findMany: findMany + count berurutan lewat tx (tx tidak punya $transaction), hasil sama', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      const rows = [{ id: 'e1' }];
      tx.event.findMany.mockResolvedValue(rows);
      tx.event.count.mockResolvedValue(1);

      const result = await withTx(tx, () =>
        new EventRepository(prisma).findMany({ page: 2, limit: 5 } as ListEventsQueryDto)
      );

      expect(tx.event.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null, tenantId: 'tenant-1' },
        skip: 5,
        take: 5,
        orderBy: { date: 'asc' },
      });
      expect(tx.event.count).toHaveBeenCalledWith({
        where: { deletedAt: null, tenantId: 'tenant-1' },
      });
      expect(result).toEqual({ data: rows, total: 1 });
      expectPrismaUntouched(prisma);
    });

    it('findById: lewat tx, tetap memfilter tenantId', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.event.findFirst.mockResolvedValue(null);

      await withTx(tx, () => new EventRepository(prisma).findById('e1'));

      expect(tx.event.findFirst).toHaveBeenCalledWith({
        where: { id: 'e1', deletedAt: null, tenantId: 'tenant-1' },
      });
      expectPrismaUntouched(prisma);
    });

    it('update: lewat tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.event.update.mockResolvedValue({ id: 'e1' });

      await withTx(tx, () => new EventRepository(prisma).update('e1', { title: 'Baru' }));

      expect(tx.event.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { title: 'Baru' },
      });
      expectPrismaUntouched(prisma);
    });

    it('delete (soft delete): lewat tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.event.update.mockResolvedValue({ id: 'e1' });

      await withTx(tx, () => new EventRepository(prisma).delete('e1'));

      expect(tx.event.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { deletedAt: expect.any(Date) },
      });
      expectPrismaUntouched(prisma);
    });
  });
});
