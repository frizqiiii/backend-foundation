import type { Request, Response } from 'express';
import type { TenantService } from './tenant.service';
import type { AuditService } from '../audit/audit.service';
import {
  createTenantSchema,
  listTenantsQuerySchema,
  updateTenantPlanSchema,
  updateTenantStatusSchema,
} from './tenant.dto';
import { sendSuccess } from '../../shared/utils/response';
import { UnauthorizedError } from '../../shared/utils/http-error';
import { getClientIp, getUserAgent } from '../../shared/utils/request-context';

/**
 * Endpoint admin platform untuk mengelola tenant — `list`/`create`
 * (Phase 11), `updatePlan` (Fase 2 item 2.11 — kuota rate limit), dan
 * `updateStatus` (T3 — ACTIVE/SUSPENDED, lihat komentar method di
 * bawah untuk implikasi akses). Penghapusan tenant (hard delete)
 * tetap ditunda ke fase enterprise berikutnya (lihat
 * `docs/tenant-migration-strategy.md`) — beda dari status/plan,
 * implikasinya (apa yang terjadi ke data anak: User/Product/Event
 * milik tenant itu) belum dirancang eksplisit.
 */
export class TenantController {
  constructor(
    private readonly tenantService: TenantService,
    private readonly auditService: AuditService
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = listTenantsQuerySchema.parse(req.query);
    const result = await this.tenantService.list(query);
    sendSuccess(res, 200, 'Daftar tenant berhasil diambil', result.data, result.meta);
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const input = createTenantSchema.parse(req.body);
    const tenant = await this.tenantService.create(input);
    sendSuccess(res, 201, 'Tenant berhasil dibuat', tenant);
  };

  updatePlan = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const input = updateTenantPlanSchema.parse(req.body);
    const { tenant, previousPlan } = await this.tenantService.updatePlan(req.params.id, input.plan);

    // Temuan T2 — perubahan plan menentukan kuota (dan kemungkinan tagihan), jadi harus
    // tercatat SIAPA yang mengubah, KAPAN, dan dari plan APA ke plan APA. Dicatat juga
    // untuk PATCH yang tidak mengubah nilai (from == to): itu tetap aksi admin yang
    // perlu bisa ditelusuri. Kegagalan menulis audit tidak menggagalkan request
    // (perilaku `AuditService` untuk semua aksi lain).
    await this.auditService.logUpdate(
      'Tenant',
      tenant.id,
      { userId: req.user.id, ipAddress: getClientIp(req), userAgent: getUserAgent(req) },
      { field: 'plan', from: previousPlan, to: tenant.plan }
    );

    sendSuccess(res, 200, 'Plan tenant berhasil diperbarui', tenant);
  };

  /**
   * T3 — ganti status tenant (ACTIVE/SUSPENDED). Sama seperti
   * `updatePlan`: perubahan ini menentukan APAKAH tenant boleh
   * diakses sama sekali (lewat header tenant MAUPUN API key — lihat
   * `shared/tenant/tenant-status.ts`), jadi WAJIB tercatat siapa yang
   * mengubah, kapan, dari status apa ke status apa — termasuk untuk
   * PATCH yang tidak mengubah nilai.
   */
  updateStatus = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const input = updateTenantStatusSchema.parse(req.body);
    const { tenant, previousStatus } = await this.tenantService.updateStatus(
      req.params.id,
      input.status
    );

    await this.auditService.logUpdate(
      'Tenant',
      tenant.id,
      { userId: req.user.id, ipAddress: getClientIp(req), userAgent: getUserAgent(req) },
      { field: 'status', from: previousStatus, to: tenant.status }
    );

    sendSuccess(res, 200, 'Status tenant berhasil diperbarui', tenant);
  };
}
