import type { Prisma, PrismaClient } from '@prisma/client';
import {
  runWithTenantContext,
  getTenantContext,
  requireTenantId,
  runInTenantTransaction,
  withTenantScope,
} from './tenant-context';

describe('tenant-context', () => {
  describe('getTenantContext', () => {
    it('mengembalikan context kosong kalau dipanggil di luar runWithTenantContext', () => {
      expect(getTenantContext()).toEqual({ tenantId: null, tenantSlug: null, db: null });
    });

    it('mengembalikan context yang di-set lewat runWithTenantContext', () => {
      runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () => {
        expect(getTenantContext()).toEqual({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null });
      });
    });

    it('tetap terbaca lewat rantai async (promise) yang dimulai di dalam context', async () => {
      await runWithTenantContext(
        { tenantId: 'tenant-2', tenantSlug: 'beta', db: null },
        async () => {
          await Promise.resolve();
          expect(getTenantContext().tenantId).toBe('tenant-2');
        }
      );
    });

    it('tidak bocor ke pemanggilan lain yang berjalan di luar context-nya', () => {
      runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () => {
        expect(getTenantContext().tenantId).toBe('tenant-1');
      });

      expect(getTenantContext()).toEqual({ tenantId: null, tenantSlug: null, db: null });
    });
  });

  describe('requireTenantId', () => {
    it('melempar error kalau tidak ada tenant context aktif', () => {
      expect(() => requireTenantId()).toThrow(/Tenant context tidak aktif/);
    });

    it('mengembalikan tenantId kalau context aktif', () => {
      runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () => {
        expect(requireTenantId()).toBe('tenant-1');
      });
    });
  });

  describe('runInTenantTransaction / withTenantScope (R19)', () => {
    function createClient() {
      const tx = { $executeRaw: jest.fn().mockResolvedValue(0) };
      const client = {
        $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      } as unknown as PrismaClient;
      return { client, tx };
    }

    it('runInTenantTransaction: membuka transaksi baru, set app.tenant_id, dan context di dalam fn membawa tx', async () => {
      const { client, tx } = createClient();

      const seen = await runInTenantTransaction(client, 'tenant-1', async () => getTenantContext());

      expect(client.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw.mock.calls[0]).toContain('tenant-1');
      expect(seen).toEqual({
        tenantId: 'tenant-1',
        tenantSlug: null,
        db: tx as unknown as Prisma.TransactionClient,
      });
      // tidak bocor keluar fn
      expect(getTenantContext()).toEqual({ tenantId: null, tenantSlug: null, db: null });
    });

    it('runInTenantTransaction: tenantId null -> fn jalan apa adanya, tanpa transaksi', async () => {
      const { client } = createClient();

      const result = await runInTenantTransaction(client, null, async () => 'ok');

      expect(result).toBe('ok');
      expect(client.$transaction).not.toHaveBeenCalled();
    });

    it('runInTenantTransaction: error dari fn diteruskan ke pemanggil', async () => {
      const { client } = createClient();

      await expect(
        runInTenantTransaction(client, 'tenant-1', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
    });

    it('withTenantScope: ada transaksi tenant ambient -> dipakai, TANPA transaksi baru', async () => {
      const { client } = createClient();
      const ambientTx = {} as unknown as Prisma.TransactionClient;

      const seen = await runWithTenantContext(
        { tenantId: 'tenant-1', tenantSlug: 'acme', db: ambientTx },
        () => withTenantScope(client, 'tenant-1', async () => getTenantContext().db)
      );

      expect(seen).toBe(ambientTx);
      expect(client.$transaction).not.toHaveBeenCalled();
    });

    it('withTenantScope: tanpa konteks (worker) -> transaksi mikro dengan tenantId dari argumen', async () => {
      const { client, tx } = createClient();

      const seen = await withTenantScope(client, 'tenant-9', async () => getTenantContext());

      expect(client.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw.mock.calls[0]).toContain('tenant-9');
      expect(seen.tenantId).toBe('tenant-9');
    });

    it('withTenantScope: konteks ada tapi db null (request tanpa header) -> tetap membuka transaksi mikro dari argumen', async () => {
      const { client } = createClient();

      await runWithTenantContext({ tenantId: null, tenantSlug: null, db: null }, () =>
        withTenantScope(client, 'tenant-9', async () => undefined)
      );

      expect(client.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
