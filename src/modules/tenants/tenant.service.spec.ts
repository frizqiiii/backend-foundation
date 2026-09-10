import { TenantService } from './tenant.service';
import type { TenantRepository } from './tenant.repository';
import { ConflictError, ForbiddenError } from '../../shared/utils/http-error';

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
});
