import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import { TenantService } from '../../modules/tenants/tenant.service';
import { runWithTenantContext } from './tenant-context';
import { TENANT_HEADER_NAME } from './tenant.constants';

// Instance module-level, sama pola dengan `*.routes.ts` lain (satu
// instance dibagi seluruh request, bukan dibuat ulang per-request) —
// tidak diimpor dari `modules/tenants/tenant.routes.ts` supaya arah
// dependency tetap konsisten dengan seluruh codebase ini
// (`modules/*` boleh bergantung ke `shared/*`, TIDAK sebaliknya).
const tenantRepository = new TenantRepository(prisma);
const tenantService = new TenantService(tenantRepository);

/**
 * Tenant Middleware (Phase 11) — dipasang GLOBAL di `app.ts`, SEBELUM
 * router bisnis mana pun (lihat urutan di `app.ts`), supaya tenant
 * context sudah aktif untuk SELURUH request sebelum menyentuh
 * Controller/Service apa pun.
 *
 * MODE TRANSISI — SENGAJA "backward compatible", BUKAN wajib:
 *   - Ada header `X-Tenant-ID` & slug-nya valid+aktif → tenant context
 *     terisi, request lanjut seperti biasa.
 *   - Ada header tapi slug tidak valid/tenant SUSPENDED → request
 *     ditolak (403) SEDINI mungkin, sebelum masuk ke logika bisnis
 *     apa pun.
 *   - TIDAK ADA header sama sekali → tenant context dibiarkan kosong
 *     (`tenantId: null`) dan request tetap lanjut TANPA error. Ini
 *     PERSIS kenapa Phase 11 ini tidak breaking terhadap seluruh
 *     endpoint yang sudah ada: client lama yang belum tahu apa-apa
 *     soal tenant tetap berfungsi seperti sebelum Phase 11 — mereka
 *     hanya belum ikut memanfaatkan isolasi tenant. Penegakan header
 *     ini menjadi WAJIB adalah keputusan terpisah untuk fase
 *     berikutnya, lihat `docs/tenant-migration-strategy.md`.
 */
export async function tenantMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawHeader = req.headers[TENANT_HEADER_NAME];
    const slug = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!slug) {
      runWithTenantContext({ tenantId: null, tenantSlug: null }, () => next());
      return;
    }

    // Melempar ForbiddenError kalau slug tidak dikenal/tenant tidak
    // aktif — ditangkap oleh `next(error)` di catch block bawah,
    // diteruskan ke `errorHandler` global seperti error lainnya.
    const tenant = await tenantService.resolveActiveTenantBySlug(slug);

    runWithTenantContext({ tenantId: tenant.id, tenantSlug: tenant.slug }, () => next());
  } catch (error) {
    next(error);
  }
}
