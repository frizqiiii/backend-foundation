import type { PrismaClient } from '@prisma/client';
import { AuditRepository } from './audit.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('AuditRepository', () => {
  it('create meneruskan data langsung ke prisma.auditLog.create', async () => {
    const prisma = createMockPrisma();
    const data = {
      userId: 'u1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
      action: 'LOGIN' as never,
      entity: 'User',
      entityId: 'u1',
    };
    const created = { id: 'a1', ...data };
    (prisma.auditLog.create as jest.Mock).mockResolvedValue(created);
    const repository = new AuditRepository(prisma);

    const result = await repository.create(data);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data });
    expect(result).toBe(created);
  });

  describe('findByUser', () => {
    it('memfilter userId + action IN login-related actions, paginasi via skip/take', async () => {
      const prisma = createMockPrisma();
      const rows = [{ id: 'a1' }];
      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue(rows);
      (prisma.auditLog.count as jest.Mock).mockResolvedValue(1);
      const repository = new AuditRepository(prisma);

      const result = await repository.findByUser('u1', { page: 2, limit: 10 });

      const expectedWhere = {
        userId: 'u1',
        action: {
          in: [
            'LOGIN',
            'LOGOUT',
            'LOGIN_FAILED',
            'SESSION_REVOKED',
            'SESSIONS_REVOKED_ALL',
            'SUSPICIOUS_LOGIN_DETECTED',
          ],
        },
      };
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: expectedWhere,
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
      });
      expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(result).toEqual({ data: rows, total: 1 });
    });

    it('page 1 menghasilkan skip 0', async () => {
      const prisma = createMockPrisma();
      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.auditLog.count as jest.Mock).mockResolvedValue(0);
      const repository = new AuditRepository(prisma);

      await repository.findByUser('u1', { page: 1, limit: 20 });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 })
      );
    });
  });

  it('findRecent mengambil SEMUA jenis action (tanpa filter where), urut createdAt desc, dibatasi limit', async () => {
    const prisma = createMockPrisma();
    const rows = [{ id: 'a1' }, { id: 'a2' }];
    (prisma.auditLog.findMany as jest.Mock).mockResolvedValue(rows);
    const repository = new AuditRepository(prisma);

    const result = await repository.findRecent(50);

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    expect(result).toBe(rows);
  });
});
