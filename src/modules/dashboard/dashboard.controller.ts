import type { Request, Response } from 'express';
import { z } from 'zod';
import type { DashboardService } from './dashboard.service';
import { sendSuccess } from '../../shared/utils/response';

const auditSummaryQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  // Kedua field harus SAMA-SAMA ada atau SAMA-SAMA kosong — rentang
  // tanggal parsial (mis. `from` tanpa `to`) ambigu: apakah maksudnya
  // "sampai sekarang" atau permintaan tidak lengkap? Lebih jelas
  // memaksa keduanya eksplisit daripada menebak.
  .refine((data) => (data.from === undefined) === (data.to === undefined), {
    message: 'from dan to harus diisi bersamaan, atau dikosongkan berdua',
  });

export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  getStats = async (_req: Request, res: Response): Promise<void> => {
    const stats = await this.dashboardService.getStats();
    sendSuccess(res, 200, 'Statistik dashboard berhasil diambil', stats);
  };

  getAuditSummary = async (req: Request, res: Response): Promise<void> => {
    const { from, to } = auditSummaryQuerySchema.parse(req.query);
    const summary = await this.dashboardService.getAuditSummary(
      from && to ? { from, to } : undefined
    );
    sendSuccess(res, 200, 'Ringkasan audit log berhasil diambil', summary);
  };
}
