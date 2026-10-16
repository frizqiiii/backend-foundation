import type { PrismaClient } from '@prisma/client';
import { DashboardRepository } from './dashboard.repository';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import { ForbiddenError } from '../../shared/utils/http-error';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  const client: Record<string, unknown> = {
    user: { count: jest.fn(), groupBy: jest.fn() },
    event: { count: jest.fn(), groupBy: jest.fn() },
    product: { count: jest.fn(), groupBy: jest.fn() },
    fileUpload: { count: jest.fn() },
    auditLog: { groupBy: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    ...overrides,
  };
  // R21: mode PLATFORM membaca events/products lewat `withRlsBypass` (`$transaction(cb)` + set_config bypass).
  client.$transaction = jest.fn(async (cb: (tx: unknown) => unknown) => cb(client));
  return client as unknown as PrismaClient;
}

describe('DashboardRepository', () => {
  it('countUsers/countEvents/countProducts/countUploads menghitung dengan filter deletedAt:null (kecuali uploads, tidak punya soft delete)', async () => {
    const prisma = createMockPrisma();
    (prisma.user.count as jest.Mock).mockResolvedValue(10);
    (prisma.event.count as jest.Mock).mockResolvedValue(5);
    (prisma.product.count as jest.Mock).mockResolvedValue(3);
    (prisma.fileUpload.count as jest.Mock).mockResolvedValue(7);
    const repository = new DashboardRepository(prisma);

    await expect(repository.countUsers()).resolves.toBe(10);
    await expect(repository.countEvents()).resolves.toBe(5);
    await expect(repository.countProducts()).resolves.toBe(3);
    await expect(repository.countUploads()).resolves.toBe(7);

    expect(prisma.user.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(prisma.event.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(prisma.product.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(prisma.fileUpload.count).toHaveBeenCalledWith();
  });

  it('countUsersByRole memetakan hasil groupBy ke {role, count}', async () => {
    const prisma = createMockPrisma();
    (prisma.user.groupBy as jest.Mock).mockResolvedValue([
      { role: 'ADMIN', _count: { _all: 2 } },
      { role: 'USER', _count: { _all: 48 } },
    ]);
    const repository = new DashboardRepository(prisma);

    const result = await repository.countUsersByRole();

    expect(result).toEqual([
      { role: 'ADMIN', count: 2 },
      { role: 'USER', count: 48 },
    ]);
  });

  it('countEventsByCategory memetakan hasil groupBy ke {category, count}', async () => {
    const prisma = createMockPrisma();
    (prisma.event.groupBy as jest.Mock).mockResolvedValue([
      { category: 'Musik', _count: { _all: 4 } },
    ]);
    const repository = new DashboardRepository(prisma);

    const result = await repository.countEventsByCategory();

    expect(result).toEqual([{ category: 'Musik', count: 4 }]);
  });

  it('countProductsByStatus memetakan hasil groupBy ke {status, count}', async () => {
    const prisma = createMockPrisma();
    (prisma.product.groupBy as jest.Mock).mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 9 } },
    ]);
    const repository = new DashboardRepository(prisma);

    const result = await repository.countProductsByStatus();

    expect(result).toEqual([{ status: 'ACTIVE', count: 9 }]);
  });

  it('countProductsByCategory memetakan hasil groupBy ke {category, count}', async () => {
    const prisma = createMockPrisma();
    (prisma.product.groupBy as jest.Mock).mockResolvedValue([
      { category: 'PREMIUM', _count: { _all: 1 } },
    ]);
    const repository = new DashboardRepository(prisma);

    const result = await repository.countProductsByCategory();

    expect(result).toEqual([{ category: 'PREMIUM', count: 1 }]);
  });

  it('countEventsUpcomingVsPast menjalankan dua count paralel dengan filter date gte/lt now', async () => {
    const prisma = createMockPrisma();
    (prisma.event.count as jest.Mock).mockResolvedValueOnce(6).mockResolvedValueOnce(4);
    const repository = new DashboardRepository(prisma);

    const result = await repository.countEventsUpcomingVsPast();

    expect(result).toEqual({ upcoming: 6, past: 4 });
    expect(prisma.event.count).toHaveBeenCalledTimes(2);
  });

  it('signupsLast30Days memetakan hasil $queryRaw (Date + bigint) ke {date: string, count: number}', async () => {
    const prisma = createMockPrisma();
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      { date: new Date('2026-08-10T00:00:00.000Z'), count: BigInt(2) },
    ]);
    const repository = new DashboardRepository(prisma);

    const result = await repository.signupsLast30Days();

    expect(result).toEqual([{ date: '2026-08-10', count: 2 }]);
  });

  describe('countAuditLogsByAction', () => {
    it('TANPA range: memanggil groupBy dengan where undefined', async () => {
      const prisma = createMockPrisma();
      (prisma.auditLog.groupBy as jest.Mock).mockResolvedValue([
        { action: 'LOGIN', _count: { _all: 20 } },
      ]);
      const repository = new DashboardRepository(prisma);

      const result = await repository.countAuditLogsByAction();

      expect(prisma.auditLog.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined })
      );
      expect(result).toEqual([{ action: 'LOGIN', count: 20 }]);
    });

    it('P5 — DENGAN range: memanggil groupBy dengan filter createdAt gte/lte sesuai range', async () => {
      const prisma = createMockPrisma();
      (prisma.auditLog.groupBy as jest.Mock).mockResolvedValue([]);
      const repository = new DashboardRepository(prisma);
      const range = { from: new Date('2026-01-01'), to: new Date('2026-01-31') };

      await repository.countAuditLogsByAction(range);

      expect(prisma.auditLog.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdAt: { gte: range.from, lte: range.to } },
        })
      );
    });
  });

  describe('R21 — mode PLATFORM (tanpa tenant): events/products lewat transaksi bypass RLS', () => {
    it('countEvents dan countProducts membuka transaksi dengan app.bypass_rls dan tidak memfilter tenant', async () => {
      const prisma = createMockPrisma();
      (prisma.event.count as jest.Mock).mockResolvedValue(5);
      (prisma.product.count as jest.Mock).mockResolvedValue(3);
      const repository = new DashboardRepository(prisma);

      await repository.countEvents();
      await repository.countProducts();

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(prisma.event.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
      expect(prisma.product.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    });

    it('countUsers tidak memakai transaksi bypass (tabel users tidak ber-RLS)', async () => {
      const prisma = createMockPrisma();
      (prisma.user.count as jest.Mock).mockResolvedValue(1);

      await new DashboardRepository(prisma).countUsers();

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('R21 — mode TENANT: hanya data tenant aktif', () => {
    const inTenant = <T>(
      prisma: PrismaClient,
      fn: (repo: DashboardRepository) => Promise<T>,
      tx: unknown = prisma
    ) =>
      runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: tx as never }, () =>
        fn(new DashboardRepository(prisma))
      );

    it('users difilter tenantId (satu-satunya pagar, tabel tidak ber-RLS)', async () => {
      const prisma = createMockPrisma();
      (prisma.user.count as jest.Mock).mockResolvedValue(2);
      (prisma.user.groupBy as jest.Mock).mockResolvedValue([]);

      await inTenant(prisma, (r) => r.countUsers());
      await inTenant(prisma, (r) => r.countUsersByRole());

      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { deletedAt: null, tenantId: 'tenant-1' },
      });
      expect(prisma.user.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null, tenantId: 'tenant-1' } })
      );
    });

    it('events dan products dibaca lewat TX request (bukan bypass), dengan filter tenantId', async () => {
      const prisma = createMockPrisma();
      const tx = createMockPrisma();
      (tx.event.count as jest.Mock).mockResolvedValue(4);
      (tx.product.count as jest.Mock).mockResolvedValue(6);
      (tx.event.groupBy as jest.Mock).mockResolvedValue([
        { category: 'Musik', _count: { _all: 4 } },
      ]);
      (tx.product.groupBy as jest.Mock).mockResolvedValue([]);

      await expect(inTenant(prisma, (r) => r.countEvents(), tx)).resolves.toBe(4);
      await expect(inTenant(prisma, (r) => r.countProducts(), tx)).resolves.toBe(6);
      await inTenant(prisma, (r) => r.countEventsByCategory(), tx);
      await inTenant(prisma, (r) => r.countProductsByStatus(), tx);
      await inTenant(prisma, (r) => r.countProductsByCategory(), tx);

      const where = { deletedAt: null, tenantId: 'tenant-1' };
      expect(tx.event.count).toHaveBeenCalledWith({ where });
      expect(tx.product.count).toHaveBeenCalledWith({ where });
      expect(tx.event.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(tx.product.groupBy).toHaveBeenCalledTimes(2);
      expect(prisma.event.count).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('countEventsUpcomingVsPast: dua count berurutan di TX request dengan filter tenantId', async () => {
      const prisma = createMockPrisma();
      const tx = createMockPrisma();
      (tx.event.count as jest.Mock).mockResolvedValueOnce(2).mockResolvedValueOnce(1);

      const result = await inTenant(prisma, (r) => r.countEventsUpcomingVsPast(), tx);

      expect(result).toEqual({ upcoming: 2, past: 1 });
      expect(tx.event.count).toHaveBeenCalledTimes(2);
      expect(tx.event.count).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) })
      );
    });

    // `$queryRaw` dipanggil sebagai tagged template: argumen pertama string statis, sisanya nilai. Filter tenant
    // disisipkan sebagai fragmen `Prisma.sql` bersarang, sehingga muncul sebagai SATU nilai bertipe Sql.
    const fragmentOf = (prisma: PrismaClient): { strings: string[]; values: unknown[] } => {
      const [, ...values] = (prisma.$queryRaw as jest.Mock).mock.calls[0] as unknown[];
      return values.find((v) => v != null && typeof v === 'object' && 'strings' in v) as {
        strings: string[];
        values: unknown[];
      };
    };

    it('signupsLast30Days menyisipkan filter tenant ke SQL (tenantId ikut sebagai parameter, bukan teks)', async () => {
      const prisma = createMockPrisma();
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await inTenant(prisma, (r) => r.signupsLast30Days());

      const fragment = fragmentOf(prisma);
      expect(fragment.strings.join('')).toContain('u.tenant_id');
      expect(fragment.strings.join('')).not.toContain('tenant-1');
      expect(fragment.values).toEqual(['tenant-1']);
    });

    it('signupsLast30Days TANPA tenant: fragmen filter kosong', async () => {
      const prisma = createMockPrisma();
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await new DashboardRepository(prisma).signupsLast30Days();

      expect(fragmentOf(prisma).strings.join('').trim()).toBe('');
    });

    it('countUploads dan countAuditLogsByAction DITOLAK (tanpa kolom tenant, hanya mode platform)', async () => {
      const prisma = createMockPrisma();

      await expect(inTenant(prisma, (r) => r.countUploads())).rejects.toThrow(ForbiddenError);
      await expect(inTenant(prisma, (r) => r.countAuditLogsByAction())).rejects.toThrow(
        ForbiddenError
      );
      expect(prisma.fileUpload.count).not.toHaveBeenCalled();
      expect(prisma.auditLog.groupBy).not.toHaveBeenCalled();
    });
  });
});
