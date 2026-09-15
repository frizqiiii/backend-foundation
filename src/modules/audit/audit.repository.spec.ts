import type { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { AuditRepository } from './audit.repository';

function canonicalize(row: {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}): string {
  return JSON.stringify({
    id: row.id,
    userId: row.userId,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  });
}

function computeHash(canonical: string, previousHash: string | null): string {
  return createHash('sha256')
    .update(`${canonical}|${previousHash ?? ''}`)
    .digest('hex');
}

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    auditLog: { create: jest.fn() },
  };
  return {
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((callback: (t: typeof tx) => unknown) => callback(tx)),
    __tx: tx, // dipakai test untuk assert langsung ke mock tx-nya
    ...overrides,
  } as unknown as PrismaClient & { __tx: typeof tx };
}

describe('AuditRepository', () => {
  describe('create (Fase 2 — hash chain)', () => {
    const data = {
      userId: 'u1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
      action: 'LOGIN' as never,
      entity: 'User',
      entityId: 'u1',
    };

    it('baris PERTAMA (chain kosong): previousHash = null (genesis)', async () => {
      const prisma = createMockPrisma();
      prisma.__tx.$queryRaw.mockResolvedValue([]); // belum ada audit_chain_state sama sekali
      const created = { id: 'a1', ...data, hash: 'x', previousHash: null };
      prisma.__tx.auditLog.create.mockResolvedValue(created);
      const repository = new AuditRepository(prisma);

      const result = await repository.create(data);

      const insertArgs = prisma.__tx.auditLog.create.mock.calls[0][0];
      expect(insertArgs.data.previousHash).toBeNull();
      expect(insertArgs.data.hash).toBe(computeHash(canonicalize({ ...insertArgs.data }), null));
      expect(result).toBe(created);
    });

    it('baris BERIKUTNYA: previousHash diambil dari audit_chain_state (SELECT ... FOR UPDATE)', async () => {
      const prisma = createMockPrisma();
      prisma.__tx.$queryRaw.mockResolvedValue([{ lastHash: 'hash-baris-sebelumnya' }]);
      prisma.__tx.auditLog.create.mockResolvedValue({ id: 'a2' });
      const repository = new AuditRepository(prisma);

      await repository.create(data);

      const insertArgs = prisma.__tx.auditLog.create.mock.calls[0][0];
      expect(insertArgs.data.previousHash).toBe('hash-baris-sebelumnya');
      expect(insertArgs.data.hash).toBe(
        computeHash(canonicalize({ ...insertArgs.data }), 'hash-baris-sebelumnya')
      );
    });

    it('mengupdate audit_chain_state.lastHash ke hash baris yang baru dibuat (untuk baris SETELAHNYA)', async () => {
      const prisma = createMockPrisma();
      prisma.__tx.$queryRaw.mockResolvedValue([]);
      prisma.__tx.auditLog.create.mockResolvedValue({ id: 'a1' });
      const repository = new AuditRepository(prisma);

      await repository.create(data);

      expect(prisma.__tx.$executeRaw).toHaveBeenCalled();
      const insertArgs = prisma.__tx.auditLog.create.mock.calls[0][0];
      // $executeRaw dipanggil via tagged template -- assert lewat isi
      // strings/values yang diterima Prisma daripada mencocokkan SQL
      // literal (lebih tahan terhadap perubahan whitespace).
      const executeRawCallArgs = prisma.__tx.$executeRaw.mock.calls[0];
      expect(executeRawCallArgs).toEqual(
        expect.arrayContaining([expect.objectContaining({ raw: expect.any(Array) })])
      );
      expect(JSON.stringify(executeRawCallArgs)).toContain(insertArgs.data.hash);
    });

    it('seluruh operasi (SELECT FOR UPDATE, INSERT, UPDATE chain state) terjadi DI DALAM SATU transaksi ($transaction)', async () => {
      const prisma = createMockPrisma();
      prisma.__tx.$queryRaw.mockResolvedValue([]);
      prisma.__tx.auditLog.create.mockResolvedValue({ id: 'a1' });
      const repository = new AuditRepository(prisma);

      await repository.create(data);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('verifyChainIntegrity (Fase 2)', () => {
    function makeRow(overrides: Record<string, unknown>): {
      id: string;
      userId: string | null;
      action: string;
      entity: string;
      entityId: string | null;
      ipAddress: string | null;
      userAgent: string | null;
      createdAt: Date;
      hash: string | null;
      previousHash: string | null;
    } {
      return {
        id: 'row-id',
        userId: 'u1',
        action: 'LOGIN',
        entity: 'User',
        entityId: 'u1',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        hash: null,
        previousHash: null,
        ...overrides,
      };
    }

    it('chain kosong (belum ada baris berhash sama sekali): valid', async () => {
      const prisma = createMockPrisma();
      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([]);
      const repository = new AuditRepository(prisma);

      const result = await repository.verifyChainIntegrity();

      expect(result).toEqual({ valid: true });
    });

    it('chain 3 baris berurutan & konsisten: valid', async () => {
      const prisma = createMockPrisma();
      const row1 = makeRow({ id: 'r1', previousHash: null });
      row1.hash = computeHash(canonicalize(row1), null);
      const row2 = makeRow({ id: 'r2', previousHash: row1.hash });
      row2.hash = computeHash(canonicalize(row2), row1.hash);
      const row3 = makeRow({ id: 'r3', previousHash: row2.hash });
      row3.hash = computeHash(canonicalize(row3), row2.hash);

      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([row1, row2, row3]);
      const repository = new AuditRepository(prisma);

      const result = await repository.verifyChainIntegrity();

      expect(result).toEqual({ valid: true });
    });

    it('TIDAK bergantung pada URUTAN baris dari database (menelusuri via tautan hash, bukan array order) — regresi dari bug nyata yang ketahuan lewat uji konkurensi', async () => {
      const prisma = createMockPrisma();
      const row1 = makeRow({ id: 'r1', previousHash: null });
      row1.hash = computeHash(canonicalize(row1), null);
      const row2 = makeRow({ id: 'r2', previousHash: row1.hash });
      row2.hash = computeHash(canonicalize(row2), row1.hash);

      // SENGAJA dikembalikan dalam urutan TERBALIK dari urutan chain
      // sebenarnya -- mensimulasikan createdAt yang collide di
      // milidetik yang sama pada insert konkuren, di mana urutan
      // hasil query tidak selalu mencerminkan urutan chain.
      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([row2, row1]);
      const repository = new AuditRepository(prisma);

      const result = await repository.verifyChainIntegrity();

      expect(result).toEqual({ valid: true });
    });

    it('mendeteksi baris yang KONTENNYA diubah (hash tidak lagi cocok)', async () => {
      const prisma = createMockPrisma();
      const row1 = makeRow({ id: 'r1', previousHash: null });
      row1.hash = computeHash(canonicalize(row1), null);
      // entity diubah SETELAH hash dihitung -- mensimulasikan tampering.
      const tamperedRow1 = { ...row1, entity: 'TAMPERED' };

      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([tamperedRow1]);
      const repository = new AuditRepository(prisma);

      const result = await repository.verifyChainIntegrity();

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.brokenAt.id).toBe('r1');
        expect(result.brokenAt.reason).toContain('Hash tidak cocok');
      }
    });

    it('mendeteksi CHAIN BERCABANG (dua baris menunjuk previousHash yang sama)', async () => {
      const prisma = createMockPrisma();
      const row1 = makeRow({ id: 'r1', previousHash: null });
      row1.hash = computeHash(canonicalize(row1), null);
      const row2a = makeRow({ id: 'r2a', previousHash: row1.hash });
      row2a.hash = computeHash(canonicalize(row2a), row1.hash);
      const row2b = makeRow({ id: 'r2b', previousHash: row1.hash }); // BERCABANG dari r1 juga
      row2b.hash = computeHash(canonicalize(row2b), row1.hash);

      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([row1, row2a, row2b]);
      const repository = new AuditRepository(prisma);

      const result = await repository.verifyChainIntegrity();

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.brokenAt.reason).toContain('bercabang');
      }
    });

    it('mendeteksi baris yang TIDAK TERHUBUNG ke genesis (mis. previousHash mengacu ke hash yang tidak ada di tabel)', async () => {
      const prisma = createMockPrisma();
      const orphan = makeRow({ id: 'orphan', previousHash: 'hash-yang-tidak-pernah-ada' });
      orphan.hash = computeHash(canonicalize(orphan), 'hash-yang-tidak-pernah-ada');

      (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([orphan]);
      const repository = new AuditRepository(prisma);

      const result = await repository.verifyChainIntegrity();

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.brokenAt.reason).toContain('tidak terhubung');
      }
    });
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
