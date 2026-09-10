import type { PrismaClient } from '@prisma/client';
import { DashboardRepository } from './dashboard.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: { count: jest.fn(), groupBy: jest.fn() },
    event: { count: jest.fn(), groupBy: jest.fn() },
    product: { count: jest.fn(), groupBy: jest.fn() },
    fileUpload: { count: jest.fn() },
    auditLog: { groupBy: jest.fn() },
    $queryRaw: jest.fn(),
    ...overrides,
  } as unknown as PrismaClient;
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
});
