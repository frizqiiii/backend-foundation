import { runWithTenantContext, getTenantContext, requireTenantId } from './tenant-context';

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
});
