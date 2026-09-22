import type { Tenant, TenantStatus } from '@prisma/client';
import type { TenantRepository } from './tenant.repository';
import type { CreateTenantDto, ListTenantsQueryDto } from './tenant.dto';
import type { TenantPlanName } from '../../shared/security/rate-limit-tiers';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/utils/http-error';
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

  /**
   * Fase 2 (item 2.11 — rate limit per-tier/plan) — plan tenant
   * berdasarkan `id`, dipakai jalur API key (`authenticateWithApiKey`)
   * yang hanya punya `ApiKey.tenantId`, bukan slug. Di-cache dengan
   * TTL sama seperti resolusi slug; `null` = tenant tidak ada/sudah
   * dihapus (pemanggil jatuh ke tier default, lihat `getRateLimitTier`).
   * Sengaja TIDAK memeriksa `status` — API key milik tenant SUSPENDED
   * bukan urusan modul rate limit; keputusan itu ada di tempat lain.
   */
  async resolvePlanById(tenantId: string): Promise<TenantPlanName | null> {
    return getOrSetCache<TenantPlanName | null>(
      cacheKeys.tenantPlanById(tenantId),
      TENANT_CACHE_TTL_SECONDS,
      async () => (await this.tenantRepository.findById(tenantId))?.plan ?? null
    );
  }

  /**
   * Fase 2 (item 2.11) — ganti plan tenant. Cache DIINVALIDASI
   * eksplisit (slug DAN id) supaya kuota baru berlaku segera di
   * instance mana pun yang berbagi Redis, tidak menunggu TTL 30 detik
   * habis. Tanpa Redis (cache tidak aktif) tidak ada yang perlu
   * diinvalidasi — pembacaan berikutnya langsung ke database.
   */
  async updatePlan(
    id: string,
    plan: TenantPlanName
  ): Promise<{ tenant: Tenant; previousPlan: TenantPlanName }> {
    const existing = await this.tenantRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Tenant tidak ditemukan');
    }
    const updated = await this.tenantRepository.updatePlan(id, plan);
    await Promise.all([
      this.invalidateSlugCache(updated.slug),
      invalidateCache(cacheKeys.tenantPlanById(id)),
    ]);
    // Temuan T2 — plan SEBELUMNYA dikembalikan supaya pemanggil (controller) bisa
    // mencatat perubahan "dari -> ke" di audit log tanpa membaca ulang (yang rawan race).
    return { tenant: updated, previousPlan: existing.plan };
  }

  async invalidateSlugCache(slug: string): Promise<void> {
    await invalidateCache(cacheKeys.tenantBySlug(slug));
  }

  /**
   * T3 — ganti status tenant (ACTIVE/SUSPENDED). Cache DIINVALIDASI
   * eksplisit (slug DAN id) — pola sama dengan `updatePlan` — supaya
   * suspend terasa SEGERA di kedua jalur enforcement (`tenantMiddleware`
   * lewat slug, `authenticateWithApiKey` lewat id), bukan menunggu
   * TTL 30 detik. Tidak dibungkus try/catch di sini (beda dari
   * `resolveTenantPlanSafe` yang fail-soft) — SENGAJA: ini keputusan
   * kontrol akses, kegagalan menulisnya harus terlihat sebagai error,
   * bukan diam-diam dianggap berhasil.
   */
  async updateStatus(
    id: string,
    status: TenantStatus
  ): Promise<{ tenant: Tenant; previousStatus: TenantStatus }> {
    const existing = await this.tenantRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Tenant tidak ditemukan');
    }
    const updated = await this.tenantRepository.updateStatus(id, status);
    await Promise.all([
      this.invalidateSlugCache(updated.slug),
      invalidateCache(cacheKeys.tenantStatusById(id)),
    ]);
    return { tenant: updated, previousStatus: existing.status };
  }

  /**
   * T3 — dipakai `authenticateWithApiKey` (jalur API key, cuma tahu
   * `ApiKey.tenantId`, bukan slug — sama alasannya seperti
   * `resolvePlanById`). Tenant yang TIDAK DITEMUKAN dianggap TIDAK
   * aktif (`false`), bukan dilempar sebagai error — konsisten dengan
   * `resolveActiveTenantBySlug` yang juga menolak slug tidak dikenal
   * maupun tenant SUSPENDED dengan cara yang sama (tidak membedakan
   * keduanya dari sudut pandang pemanggil). SENGAJA TIDAK fail-soft:
   * error dari cache/database di sini dibiarkan MENJALAR ke pemanggil
   * (beda dari `resolveTenantPlanSafe`) — lihat komentar di
   * `shared/tenant/tenant-status.ts` untuk alasan lengkapnya.
   */
  async isActiveById(tenantId: string): Promise<boolean> {
    const status = await getOrSetCache<TenantStatus | 'NOT_FOUND'>(
      cacheKeys.tenantStatusById(tenantId),
      TENANT_CACHE_TTL_SECONDS,
      async () => (await this.tenantRepository.findById(tenantId))?.status ?? 'NOT_FOUND'
    );
    return status === 'ACTIVE';
  }
}
