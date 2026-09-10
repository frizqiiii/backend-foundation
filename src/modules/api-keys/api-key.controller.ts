import type { Request, Response } from 'express';
import type { ApiKeyService } from './api-key.service';
import { createApiKeySchema } from './api-key.dto';
import { sendSuccess } from '../../shared/utils/response';
import { UnauthorizedError } from '../../shared/utils/http-error';

/**
 * Self-service SEPENUHNYA — `req.user` (dari `authMiddleware`) yang
 * menentukan pemilik key, TIDAK PERNAH menerima `userId` dari body.
 * Tidak ada endpoint admin "buat API key untuk user lain" di fase
 * ini — analog dengan `MfaController`.
 */
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const input = createApiKeySchema.parse(req.body);
    const result = await this.apiKeyService.create({ id: user.id, role: user.role }, input);

    sendSuccess(
      res,
      201,
      'API key berhasil dibuat. SIMPAN rawKey ini sekarang — tidak akan ditampilkan lagi.',
      result
    );
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const keys = await this.apiKeyService.listForUser(user.id);
    sendSuccess(res, 200, 'Daftar API key berhasil diambil', keys);
  };

  revoke = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    await this.apiKeyService.revoke(user.id, req.params.id);
    sendSuccess(res, 200, 'API key berhasil dicabut', null);
  };

  // Guard eksplisit, pola yang sama dengan `AuthController.logout`/
  // `listSessions` — lihat komentar lengkap di `MfaController.getRequestUser`.
  private requireUser(req: Request): NonNullable<Request['user']> {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    return req.user;
  }
}
