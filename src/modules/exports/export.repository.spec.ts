import type { Prisma, PrismaClient } from '@prisma/client';
import { ExportRepository } from './export.repository';
import { getTenantContext, runWithTenantContext } from '../../shared/tenant/tenant-context';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    exportJob: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('ExportRepository', () => {
  it('create membuat job dengan status QUEUED', async () => {
    const prisma = createMockPrisma();
    const created = { id: 'e1', status: 'QUEUED' };
    (prisma.exportJob.create as jest.Mock).mockResolvedValue(created);
    const repository = new ExportRepository(prisma);

    const result = await repository.create({
      userId: 'u1',
      tenantId: null,
      type: 'EVENTS' as never,
      format: 'CSV' as never,
    });

    expect(prisma.exportJob.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        tenantId: null,
        type: 'EVENTS',
        format: 'CSV',
        status: 'QUEUED',
      },
    });
    expect(result).toBe(created);
  });

  it('findById mencari job berdasarkan id, tanpa scoping user', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.findUnique as jest.Mock).mockResolvedValue(null);
    const repository = new ExportRepository(prisma);

    await repository.findById('e1');

    expect(prisma.exportJob.findUnique).toHaveBeenCalledWith({ where: { id: 'e1' } });
  });

  it('findByIdForUser menyertakan userId di where (mencegah user lain mengintip job)', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.findFirst as jest.Mock).mockResolvedValue(null);
    const repository = new ExportRepository(prisma);

    await repository.findByIdForUser('e1', 'u1');

    expect(prisma.exportJob.findFirst).toHaveBeenCalledWith({ where: { id: 'e1', userId: 'u1' } });
  });

  it('markProcessing mengubah status jadi PROCESSING', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.update as jest.Mock).mockResolvedValue({});
    const repository = new ExportRepository(prisma);

    await repository.markProcessing('e1', null);

    expect(prisma.exportJob.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { status: 'PROCESSING' },
    });
  });

  it('markCompleted mengisi status COMPLETED, fileUrl, dan completedAt', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.update as jest.Mock).mockResolvedValue({});
    const repository = new ExportRepository(prisma);

    await repository.markCompleted('e1', null, 'https://cdn.example.com/e1.csv');

    expect(prisma.exportJob.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: {
        status: 'COMPLETED',
        fileUrl: 'https://cdn.example.com/e1.csv',
        completedAt: expect.any(Date),
      },
    });
  });

  it('markFailed mengisi status FAILED, errorMessage, dan completedAt', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.update as jest.Mock).mockResolvedValue({});
    const repository = new ExportRepository(prisma);

    await repository.markFailed('e1', null, 'timeout');

    expect(prisma.exportJob.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: {
        status: 'FAILED',
        errorMessage: 'timeout',
        completedAt: expect.any(Date),
      },
    });
  });

  // R19 — `export_jobs` ber-FORCE RLS. Dua konteks: request (transaksi tenant ambient dari `tenantMiddleware`) dan worker
  // BullMQ (tanpa konteks; tenant dari data job). Query yang lolos ke `this.prisma` = koneksi tanpa `app.tenant_id`.
  describe('di bawah RLS (tenant)', () => {
    function createMockTx() {
      return {
        $executeRaw: jest.fn().mockResolvedValue(0),
        exportJob: {
          create: jest.fn(),
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          update: jest.fn(),
        },
      };
    }

    // `$transaction` palsu: menjalankan callback dengan `tx` palsu (seperti Prisma sungguhan).
    function createPrismaWithTx(tx: ReturnType<typeof createMockTx>) {
      const prisma = createMockPrisma({
        $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      });
      return prisma;
    }

    function asAmbient<T>(tx: ReturnType<typeof createMockTx>, fn: () => T): T {
      return runWithTenantContext(
        {
          tenantId: 'tenant-1',
          tenantSlug: 'acme',
          db: tx as unknown as Prisma.TransactionClient,
        },
        fn
      );
    }

    function expectPrismaModelUntouched(prisma: PrismaClient) {
      expect(prisma.exportJob.create).not.toHaveBeenCalled();
      expect(prisma.exportJob.findUnique).not.toHaveBeenCalled();
      expect(prisma.exportJob.findFirst).not.toHaveBeenCalled();
      expect(prisma.exportJob.update).not.toHaveBeenCalled();
    }

    const createInput = {
      userId: 'u1',
      tenantId: 'tenant-1',
      type: 'USERS' as never,
      format: 'CSV' as never,
    };

    it('create: transaksi MANDIRI (ter-commit sebelum enqueue) dengan app.tenant_id, query lewat tx', async () => {
      const tx = createMockTx();
      tx.exportJob.create.mockResolvedValue({ id: 'e1' });
      const prisma = createPrismaWithTx(tx);
      const repository = new ExportRepository(prisma);

      const result = await repository.create(createInput);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw.mock.calls[0]).toContain('tenant-1');
      expect(tx.exportJob.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          tenantId: 'tenant-1',
          type: 'USERS',
          format: 'CSV',
          status: 'QUEUED',
        },
      });
      expect(result).toEqual({ id: 'e1' });
      expectPrismaModelUntouched(prisma);
    });

    it('create: tetap transaksi MANDIRI walau ada transaksi request ambient (agar tidak ikut menunggu commit request)', async () => {
      const ambientTx = createMockTx();
      const ownTx = createMockTx();
      ownTx.exportJob.create.mockResolvedValue({ id: 'e1' });
      const prisma = createPrismaWithTx(ownTx);
      const repository = new ExportRepository(prisma);

      await asAmbient(ambientTx, () => repository.create(createInput));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(ownTx.exportJob.create).toHaveBeenCalledTimes(1);
      expect(ambientTx.exportJob.create).not.toHaveBeenCalled();
    });

    it('findByIdForUser dan findById memakai tx ambient, BUKAN this.prisma', async () => {
      const tx = createMockTx();
      tx.exportJob.findFirst.mockResolvedValue({ id: 'e1' });
      tx.exportJob.findUnique.mockResolvedValue({ id: 'e1' });
      const prisma = createMockPrisma();
      const repository = new ExportRepository(prisma);

      await asAmbient(tx, () => repository.findByIdForUser('e1', 'u1'));
      await asAmbient(tx, () => repository.findById('e1'));

      expect(tx.exportJob.findFirst).toHaveBeenCalledWith({ where: { id: 'e1', userId: 'u1' } });
      expect(tx.exportJob.findUnique).toHaveBeenCalledWith({ where: { id: 'e1' } });
      expectPrismaModelUntouched(prisma);
    });

    it('mark*: DENGAN tx ambient (alur request/fallback sinkron) memakai tx itu, tanpa transaksi baru', async () => {
      const tx = createMockTx();
      tx.exportJob.update.mockResolvedValue({});
      const prisma = createMockPrisma({ $transaction: jest.fn() });
      const repository = new ExportRepository(prisma);

      await asAmbient(tx, async () => {
        await repository.markProcessing('e1', 'tenant-1');
        await repository.markCompleted('e1', 'tenant-1', 'https://cdn.example.com/e1.csv');
        await repository.markFailed('e1', 'tenant-1', 'gagal');
      });

      expect(tx.exportJob.update).toHaveBeenCalledTimes(3);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expectPrismaModelUntouched(prisma);
    });

    it('mark*: TANPA konteks (worker BullMQ) membuka transaksi mikro per langkah dengan app.tenant_id dari data job', async () => {
      const tx = createMockTx();
      tx.exportJob.update.mockResolvedValue({});
      const prisma = createPrismaWithTx(tx);
      const repository = new ExportRepository(prisma);

      await repository.markProcessing('e1', 'tenant-1');
      await repository.markCompleted('e1', 'tenant-1', 'https://cdn.example.com/e1.csv');
      await repository.markFailed('e1', 'tenant-1', 'gagal');

      // tiap langkah = transaksi sendiri (ter-commit per langkah), masing-masing men-set app.tenant_id
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
      for (const call of tx.$executeRaw.mock.calls) {
        expect(call).toContain('tenant-1');
      }
      expect(tx.exportJob.update).toHaveBeenCalledTimes(3);
      expectPrismaModelUntouched(prisma);
    });

    it('mark*: tenantId null TANPA konteks tidak membuka transaksi (fail-closed di database, bukan lintas tenant)', async () => {
      const prisma = createMockPrisma({ $transaction: jest.fn() });
      (prisma.exportJob.update as jest.Mock).mockResolvedValue({});
      const repository = new ExportRepository(prisma);

      await repository.markProcessing('e1', null);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.exportJob.update).toHaveBeenCalledTimes(1);
    });
    // R22 — `runInTenantScope`: scope tenant untuk PEMBANGUNAN dataset (bukan hanya `mark*`).
    describe('runInTenantScope (R22)', () => {
      it('TANPA konteks (worker): membuka transaksi dengan app.tenant_id dari data job dan memasang konteks tenant selama fn', async () => {
        const tx = createMockTx();
        const prisma = createPrismaWithTx(tx);
        const repository = new ExportRepository(prisma);
        let seen: { tenantId: string | null; db: unknown } | undefined;

        const result = await repository.runInTenantScope('tenant-1', async () => {
          const ctx = getTenantContext();
          seen = { tenantId: ctx.tenantId, db: ctx.db };
          return 'hasil';
        });

        expect(result).toBe('hasil');
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.$executeRaw.mock.calls[0]).toContain('tenant-1');
        expect(seen).toEqual({ tenantId: 'tenant-1', db: tx });
      });

      it('DENGAN tx ambient (fallback sinkron): memakai tx itu, tanpa transaksi baru', async () => {
        const tx = createMockTx();
        const prisma = createPrismaWithTx(tx);
        const repository = new ExportRepository(prisma);

        const result = await asAmbient(tx, () =>
          repository.runInTenantScope('tenant-1', async () => 'hasil')
        );

        expect(result).toBe('hasil');
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('tenantId null TANPA konteks ditolak (fail-closed): fn tidak dijalankan, tidak ada transaksi', async () => {
        const prisma = createMockPrisma({ $transaction: jest.fn() });
        const repository = new ExportRepository(prisma);
        const fn = jest.fn().mockResolvedValue('tidak-boleh');

        await expect(repository.runInTenantScope(null, fn)).rejects.toThrow(/terikat tenant/);

        expect(fn).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('error dari fn diteruskan apa adanya', async () => {
        const tx = createMockTx();
        const repository = new ExportRepository(createPrismaWithTx(tx));

        await expect(
          repository.runInTenantScope('tenant-1', async () => {
            throw new Error('query gagal');
          })
        ).rejects.toThrow('query gagal');
      });
    });
  });
});
