import type { Tenant } from '@prisma/client';
import type { TenantRepository } from './tenant.repository';
import type { CreateTenantDto, ListTenantsQueryDto } from './tenant.dto';
import { ConflictError, ForbiddenError } from '../../shared/utils/http-error';
import { getOrSetCache, invalidateCache } from '../../shared/utils/cache';
import { cacheKeys } from '../../shared/utils/cache-keys';

/**
 * TTL pendek — sama alasannya seperti `FeatureFlagService`: resolusi
 * tenant dipanggil di hot path (`tenantMiddleware`, pada SETIAP
 * request yang membawa header tenant), jadi harus di-cache, tapi
 * perubahan `status` tenant (mis. di-SUSPEND karena nunggak) tidak
 * boleh butuh waktu lama untuk terasa efeknya.
 */
const TENANT_CACHE_TTL_SECONDS = 30;

export class TenantService {
  constructor(private readonly tenantRepository: TenantRepository) {}

  /**
   * P3 (Database Audit) — dipaginasi, pola sama dengan
   * `UserService.listUsers`/`EventService.listEvents`.
   */
  async list(query: ListTenantsQueryDto): Promise<{
    data: Tenant[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const skip = (query.page - 1) * query.limit;
    const { data, total } = await this.tenantRepository.findMany({ skip, take: query.limit });
    return {
      data,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async create(input: CreateTenantDto): Promise<Tenant> {
    const existing = await this.tenantRepository.findBySlug(input.slug);
    if (existing) {
      throw new ConflictError(`Tenant dengan slug "${input.slug}" sudah terdaftar`);
    }
    return this.tenantRepository.create(input);
  }

  /**
   * Dipakai OLEH `tenantMiddleware` — resolusi `slug` header ke
   * tenant yang valid & aktif. Melempar `ForbiddenError` (bukan
   * `NotFoundError`) untuk slug yang tidak dikenal MAUPUN yang
   * berstatus SUSPENDED — dari sudut pandang client, keduanya sama:
   * "Anda tidak boleh mengakses tenant ini sekarang", dan tidak
   * membedakan keduanya juga mencegah kebocoran informasi soal slug
   * mana yang benar-benar terdaftar tapi sedang dibekukan.
   */
  async resolveActiveTenantBySlug(slug: string): Promise<Tenant> {
    const tenant = await getOrSetCache(cacheKeys.tenantBySlug(slug), TENANT_CACHE_TTL_SECONDS, () =>
      this.tenantRepository.findBySlug(slug)
    );

    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new ForbiddenError(`Tenant "${slug}" tidak ditemukan atau sedang tidak aktif`);
    }

    return tenant;
  }

  async invalidateSlugCache(slug: string): Promise<void> {
    await invalidateCache(cacheKeys.tenantBySlug(slug));
  }
}
