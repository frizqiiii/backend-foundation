import { TenantService } from './tenant.service';
import type { TenantRepository } from './tenant.repository';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/utils/http-error';

/**
 * Sama seperti `feature-flag.service.spec.ts` — `redisClient` bernilai
 * `null` di lingkungan test, jadi `getOrSetCache` otomatis fallback
 * langsung ke `fetcher()` tanpa cache. Test ini cukup mock Repository.
 */
describe('TenantService', () => {
  let tenantRepository: jest.Mocked<TenantRepository>;
  let tenantService: TenantService;

  const activeTenant = {
    id: 'tenant-1',
    slug: 'acme',
    name: 'Acme Corp',
    status: 'ACTIVE' as const,
    plan: 'PRO' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(() => {
    tenantRepository = {
      findBySlug: jest.fn(),
      findById: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updatePlan: jest.fn(),
      updateStatus: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as jest.Mocked<TenantRepository>;

    tenantService = new TenantService(tenantRepository);
  });

  describe('create', () => {
    it('melempar ConflictError kalau slug sudah terdaftar', async () => {
      tenantRepository.findBySlug.mockResolvedValue(activeTenant);

      await expect(tenantService.create({ slug: 'acme', name: 'Acme Corp' })).rejects.toThrow(
        ConflictError
      );
      expect(tenantRepository.create).not.toHaveBeenCalled();
    });

    it('membuat tenant baru kalau slug belum terdaftar', async () => {
      tenantRepository.findBySlug.mockResolvedValue(null);
      tenantRepository.create.mockResolvedValue(activeTenant);

      const result = await tenantService.create({ slug: 'acme', name: 'Acme Corp' });

      expect(tenantRepository.create).toHaveBeenCalledWith({ slug: 'acme', name: 'Acme Corp' });
      expect(result).toEqual(activeTenant);
    });

    it('item 2.11 — meneruskan `plan` eksplisit ke repository (tenant baru bisa langsung FREE/ENTERPRISE)', async () => {
      tenantRepository.findBySlug.mockResolvedValue(null);
      tenantRepository.create.mockResolvedValue({ ...activeTenant, plan: 'FREE' });

      await tenantService.create({ slug: 'acme', name: 'Acme Corp', plan: 'FREE' });

      expect(tenantRepository.create).toHaveBeenCalledWith({
        slug: 'acme',
        name: 'Acme Corp',
        plan: 'FREE',
      });
    });
  });

  describe('resolvePlanById (item 2.11)', () => {
    it('mengembalikan plan tenant', async () => {
      tenantRepository.findById.mockResolvedValue({ ...activeTenant, plan: 'ENTERPRISE' });

      await expect(tenantService.resolvePlanById('tenant-1')).resolves.toBe('ENTERPRISE');
      expect(tenantRepository.findById).toHaveBeenCalledWith('tenant-1');
    });

    it('mengembalikan null (bukan melempar) kalau tenant tidak ada — pemanggil jatuh ke tier default', async () => {
      tenantRepository.findById.mockResolvedValue(null);

      await expect(tenantService.resolvePlanById('hilang')).resolves.toBeNull();
    });
  });

  describe('updatePlan (item 2.11)', () => {
    it('melempar NotFoundError kalau tenant tidak ada, TANPA menulis apa pun', async () => {
      tenantRepository.findById.mockResolvedValue(null);

      await expect(tenantService.updatePlan('hilang', 'FREE')).rejects.toThrow(NotFoundError);
      expect(tenantRepository.updatePlan).not.toHaveBeenCalled();
    });

    it('menyimpan plan baru lewat repository dan mengembalikan tenant yang sudah diperbarui', async () => {
      const updated = { ...activeTenant, plan: 'ENTERPRISE' as const };
      tenantRepository.findById.mockResolvedValue(activeTenant);
      tenantRepository.updatePlan.mockResolvedValue(updated);

      const result = await tenantService.updatePlan('tenant-1', 'ENTERPRISE');

      expect(tenantRepository.updatePlan).toHaveBeenCalledWith('tenant-1', 'ENTERPRISE');
      expect(result.tenant).toEqual(updated);
    });

    it('temuan T2 — mengembalikan plan SEBELUMNYA (dibaca sebelum menulis) supaya controller bisa mencatat "dari -> ke" di audit log', async () => {
      tenantRepository.findById.mockResolvedValue({ ...activeTenant, plan: 'FREE' as const });
      tenantRepository.updatePlan.mockResolvedValue({
        ...activeTenant,
        plan: 'ENTERPRISE' as const,
      });

      const result = await tenantService.updatePlan('tenant-1', 'ENTERPRISE');

      expect(result.previousPlan).toBe('FREE');
      expect(result.tenant.plan).toBe('ENTERPRISE');
    });
  });

  describe('list', () => {
    it('P3 — memaginasi hasil dan menghitung meta dari total repository (bukan lagi unbounded)', async () => {
      tenantRepository.findMany.mockResolvedValue({ data: [activeTenant], total: 42 });

      const result = await tenantService.list({ page: 2, limit: 10 });

      expect(tenantRepository.findMany).toHaveBeenCalledWith({ skip: 10, take: 10 });
      expect(result).toEqual({
        data: [activeTenant],
        meta: { page: 2, limit: 10, total: 42, totalPages: 5 },
      });
    });
  });

  describe('resolveActiveTenantBySlug', () => {
    it('mengembalikan tenant kalau ditemukan dan ACTIVE', async () => {
      tenantRepository.findBySlug.mockResolvedValue(activeTenant);

      const result = await tenantService.resolveActiveTenantBySlug('acme');

      expect(result).toEqual(activeTenant);
    });

    it('melempar ForbiddenError kalau slug tidak ditemukan', async () => {
      tenantRepository.findBySlug.mockResolvedValue(null);

      await expect(tenantService.resolveActiveTenantBySlug('tidak-ada')).rejects.toThrow(
        ForbiddenError
      );
    });

    it('melempar ForbiddenError kalau tenant berstatus SUSPENDED', async () => {
      tenantRepository.findBySlug.mockResolvedValue({ ...activeTenant, status: 'SUSPENDED' });

      await expect(tenantService.resolveActiveTenantBySlug('acme')).rejects.toThrow(ForbiddenError);
    });
  });

  describe('updateStatus (T3)', () => {
    it('melempar NotFoundError kalau tenant tidak ada, TANPA menulis apa pun', async () => {
      tenantRepository.findById.mockResolvedValue(null);

      await expect(tenantService.updateStatus('hilang', 'SUSPENDED')).rejects.toThrow(
        NotFoundError
      );
      expect(tenantRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('menyimpan status baru lewat repository dan mengembalikan tenant yang sudah diperbarui', async () => {
      const suspended = { ...activeTenant, status: 'SUSPENDED' as const };
      tenantRepository.findById.mockResolvedValue(activeTenant);
      tenantRepository.updateStatus.mockResolvedValue(suspended);

      const result = await tenantService.updateStatus('tenant-1', 'SUSPENDED');

      expect(tenantRepository.updateStatus).toHaveBeenCalledWith('tenant-1', 'SUSPENDED');
      expect(result.tenant).toEqual(suspended);
    });

    it('mengembalikan status SEBELUMNYA (dibaca sebelum menulis) supaya controller bisa mencatat "dari -> ke" di audit log — pola sama seperti updatePlan/T2', async () => {
      tenantRepository.findById.mockResolvedValue({ ...activeTenant, status: 'ACTIVE' as const });
      tenantRepository.updateStatus.mockResolvedValue({
        ...activeTenant,
        status: 'SUSPENDED' as const,
      });

      const result = await tenantService.updateStatus('tenant-1', 'SUSPENDED');

      expect(result.previousStatus).toBe('ACTIVE');
      expect(result.tenant.status).toBe('SUSPENDED');
    });
  });

  describe('isActiveById (T3 — dipakai jalur API key)', () => {
    it('mengembalikan true kalau tenant ditemukan dan ACTIVE', async () => {
      tenantRepository.findById.mockResolvedValue(activeTenant);

      await expect(tenantService.isActiveById('tenant-1')).resolves.toBe(true);
    });

    it('mengembalikan false kalau tenant SUSPENDED', async () => {
      tenantRepository.findById.mockResolvedValue({ ...activeTenant, status: 'SUSPENDED' });

      await expect(tenantService.isActiveById('tenant-1')).resolves.toBe(false);
    });

    it('mengembalikan false (bukan melempar) kalau tenant tidak ditemukan — konsisten dengan resolveActiveTenantBySlug yang tidak membedakan "tidak ada" dari "tidak aktif"', async () => {
      tenantRepository.findById.mockResolvedValue(null);

      await expect(tenantService.isActiveById('hilang')).resolves.toBe(false);
    });
  });
});
