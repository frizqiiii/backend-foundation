import type { Request, Response } from 'express';
import type { UploadService } from './upload.service';
import type { ActivityService } from '../activity/activity.service';
import { BadRequestError, UnauthorizedError } from '../../shared/utils/http-error';
import { sendSuccess } from '../../shared/utils/response';
import { getClientIp, getUserAgent } from '../../shared/utils/request-context';

/**
 * Controller Layer modul `upload` — HANYA HTTP concerns. `req.file`
 * diisi oleh middleware `upload.single('file')` (multer) sebelum
 * handler ini berjalan (lihat `upload.routes.ts`).
 */
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly activityService: ActivityService
  ) {}

  uploadSingle = async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      throw new BadRequestError('Tidak ada file yang dikirim. Sertakan field "file".');
    }
    // `authMiddleware` sudah wajib di `upload.routes.ts`, jadi
    // `req.user` seharusnya selalu terisi di sini — dicek ulang murni
    // untuk keamanan tipe TypeScript (narrowing), bukan alur bisnis
    // baru yang benar-benar diharapkan tercapai.
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const result = await this.uploadService.uploadFile(
      {
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        originalname: req.file.originalname,
      },
      req.user.id
    );

    await this.activityService.logFileUpload(
      `User mengupload file "${req.file.originalname}"`,
      { userId: req.user.id, ipAddress: getClientIp(req), userAgent: getUserAgent(req) },
      { originalname: req.file.originalname, mimetype: req.file.mimetype, sizeBytes: req.file.size }
    );

    sendSuccess(res, 201, 'File berhasil diupload', result);
  };

  /**
   * "Access" (Phase 4) — otorisasi kepemilikan (pemilik ATAU
   * `upload.moderate`) ditegakkan di `UploadService.getFile`, bukan di
   * sini, pola sama seperti Controller modul lain.
   */
  getById = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const file = await this.uploadService.getFile(req.params.id, req.user);

    sendSuccess(res, 200, 'Metadata file berhasil diambil', file);
  };

  /**
   * "Delete" (Phase 4) — sama seperti `getById`, otorisasi di Service.
   */
  remove = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.uploadService.deleteFile(req.params.id, req.user);

    await this.activityService.logFileUpload(
      `User menghapus file (id: ${req.params.id})`,
      { userId: req.user.id, ipAddress: getClientIp(req), userAgent: getUserAgent(req) },
      { fileId: req.params.id }
    );

    sendSuccess(res, 200, 'File berhasil dihapus', null);
  };
}
