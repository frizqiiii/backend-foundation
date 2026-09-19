import type { Request, Response } from 'express';
import type { TenantService } from './tenant.service';
import { createTenantSchema, listTenantsQuerySchema, updateTenantPlanSchema } from './tenant.dto';
import { sendSuccess } from '../../shared/utils/response';

/**
 * Endpoint admin platform untuk mengelola tenant — SENGAJA hanya
 * `list`/`create` di fase Foundation ini (Phase 11), plus `updatePlan`
 * (Fase 2 item 2.11 — hanya mengubah kuota rate limit, tanpa implikasi
 * ke sesi user). Update/suspend
 * status dan penghapusan tenant ditunda ke fase enterprise berikutnya
 * (lihat `docs/tenant-migration-strategy.md`) karena keduanya punya
 * implikasi lebih besar (mis. apa yang terjadi pada session user
 * aktif milik tenant yang baru saja di-SUSPEND) yang perlu dirancang
 * eksplisit, bukan ditempel terburu-buru di fase yang sama dengan
 * peletakan fondasi skema.
 */
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

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
    const input = updateTenantPlanSchema.parse(req.body);
    const tenant = await this.tenantService.updatePlan(req.params.id, input.plan);
    sendSuccess(res, 200, 'Plan tenant berhasil diperbarui', tenant);
  };
}
