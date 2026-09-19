import { prisma } from '../config/database';
import { logger } from '../logger';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import { TenantService } from '../../modules/tenants/tenant.service';
import type { TenantPlanName } from '../security/rate-limit-tiers';

// Instance module-level — pola & alasan sama dengan
// `tenant.middleware.ts` (modul ini SATU-SATUNYA di `shared/` selain
// itu yang butuh `TenantService`; tidak diimpor dari
// `modules/tenants/tenant.routes.ts` supaya arah dependency tetap
// `modules/* -> shared/*`, bukan sebaliknya).
const tenantService = new TenantService(new TenantRepository(prisma));

/**
 * Fase 2 (item 2.11 — rate limit per-tier/plan) — plan tenant untuk
 * jalur API key. `null` = tidak diketahui (API key tanpa tenant di
 * masa transisi Phase 11, tenant sudah tidak ada, ATAU lookup gagal)
 * — pemanggil meneruskannya apa adanya ke `getRateLimitTier`, yang
 * jatuh ke tier default.
 *
 * FAIL-SOFT SENGAJA (tidak pernah melempar): ini dipanggil di jalur
 * autentikasi SETIAP request API key. Database yang sedang lambat/
 * error saat mencari PLAN tidak boleh berubah jadi 500 untuk request
 * yang API key-nya sendiri sah — konsekuensi terburuknya cuma kuota
 * tier default (bukan tier sebenarnya) berlaku untuk request itu,
 * pola sama dengan fail-open Redis di `api-key-gateway.ts`.
 */
export async function resolveTenantPlanSafe(
  tenantId: string | null
): Promise<TenantPlanName | null> {
  if (!tenantId) {
    return null;
  }
  try {
    return await tenantService.resolvePlanById(tenantId);
  } catch (error) {
    logger.warn(
      { err: error, tenantId },
      'resolveTenantPlanSafe: gagal membaca plan tenant — memakai tier default untuk request ini'
    );
    return null;
  }
}
