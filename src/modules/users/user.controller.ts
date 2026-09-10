import type { Request, Response } from 'express';
import type { UserService } from './user.service';
import type { AuditService } from '../audit/audit.service';
import { listUsersQuerySchema } from './user.dto';
import { UnauthorizedError } from '../../shared/utils/http-error';
import { sendSuccess } from '../../shared/utils/response';
import { getClientIp, getUserAgent } from '../../shared/utils/request-context';

/**
 * Controller Layer modul `users`.
 * Catatan konsolidasi (#2 — Auth): `register`/`login` sudah dipindah
 * ke `modules/auth/auth.controller.ts`.
 */
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly auditService: AuditService
  ) {}

  /**
   * Endpoint terproteksi — `req.user` dipastikan terisi oleh
   * `authMiddleware` sebelum handler ini dijalankan. Pengecekan di
   * bawah adalah safety-net untuk TypeScript & skenario tak terduga,
   * bukan alur utama.
   */
  me = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const profile = await this.userService.getProfile(req.user.id);

    sendSuccess(res, 200, 'Profil berhasil diambil', profile);
  };

  /**
   * Endpoint khusus admin — otorisasi permission sudah ditegakkan oleh
   * `requirePermission('user.manage')` di `user.routes.ts` sebelum
   * handler ini dijalankan, jadi tidak ada pengecekan permission di
   * sini. Dipaginasi (Phase 3) — lihat `UserService.listUsers`.
   */
  list = async (req: Request, res: Response): Promise<void> => {
    const query = listUsersQuerySchema.parse(req.query);
    const result = await this.userService.listUsers(query);

    sendSuccess(res, 200, 'Daftar user berhasil diambil', result.data, result.meta);
  };

  /**
   * Soft delete (Phase 3) — otorisasi permission sama seperti `list`,
   * ditegakkan di routing, bukan di sini.
   */
  remove = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.userService.deleteUser(req.params.id);

    await this.auditService.logDelete('User', req.params.id, {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, 200, 'User berhasil dihapus', null);
  };
}
