import type { Request, Response } from 'express';
import type { ExportService } from './export.service';
import { createExportRequestSchema } from './export.dto';
import type { ExportJobResponseDto } from './export.dto';
import type { ExportJob } from './export.repository';
import { sendSuccess } from '../../shared/utils/response';
import { UnauthorizedError, ConflictError } from '../../shared/utils/http-error';
import { getTenantContext } from '../../shared/tenant/tenant-context';

function toResponseDto(exportJob: ExportJob): ExportJobResponseDto {
  return {
    id: exportJob.id,
    type: exportJob.type,
    format: exportJob.format,
    status: exportJob.status,
    fileUrl: exportJob.fileUrl,
    errorMessage: exportJob.errorMessage,
    createdAt: exportJob.createdAt,
    completedAt: exportJob.completedAt,
  };
}

export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    const body = createExportRequestSchema.parse(req.body);
    const { tenantId } = getTenantContext();

    const exportJob = await this.exportService.requestExport({
      userId: req.user.id,
      tenantId,
      type: body.type,
      format: body.format,
    });

    sendSuccess(res, 202, 'Permintaan export diterima', toResponseDto(exportJob));
  };

  getStatus = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    const exportJob = await this.exportService.getExportStatus(req.params.id, req.user.id);
    sendSuccess(res, 200, 'Status export', toResponseDto(exportJob));
  };

  download = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    const exportJob = await this.exportService.getExportStatus(req.params.id, req.user.id);

    if (exportJob.status !== 'COMPLETED' || !exportJob.fileUrl) {
      throw new ConflictError(`Export belum siap diunduh (status saat ini: ${exportJob.status})`);
    }

    // Redirect ke URL object storage — SENGAJA TIDAK men-stream file
    // lewat proses API server ini (baca dari S3/disk lalu pipe ke
    // response), supaya bandwidth/latensi download besar tidak
    // membebani proses yang sama yang melayani seluruh request HTTP
    // lain. Pola sama seperti presigned-URL download pada umumnya.
    res.redirect(302, exportJob.fileUrl);
  };
}
