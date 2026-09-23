import type { Request, Response } from 'express';
import type { ApiKeyService } from './api-key.service';
import type { AuditService } from '../audit/audit.service';
import { createApiKeySchema, updateApiKeyRateLimitOverrideSchema } from './api-key.dto';
import { sendSuccess } from '../../shared/utils/response';
import { UnauthorizedError } from '../../shared/utils/http-error';
import { getClientIp, getUserAgent } from '../../shared/utils/request-context';

/**
 * Sebagian besar method di sini self-service (`create`/`list`/`revoke`)
 * — `req.user` yang menentukan pemilik key, TIDAK PERNAH menerima
 * `userId` dari body, tidak ada endpoint admin "buat/lihat API key
 * user lain" di fase ini. `updateRateLimitOverride` (T4) adalah
 * PENGECUALIAN SENGAJA: itu operasi admin (permission `api-key.manage`,
 * lihat `api-key.routes.ts`) yang justru harus bisa menjangkau key
 * MILIK USER MANA PUN — bukan "buat key untuk user lain", tapi
 * "beri pengecualian kuota untuk key yang sudah ada".
 */
export class ApiKeyController {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly auditService: AuditService
  ) {}

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

  /**
   * T4 — admin, permission `api-key.manage` (bukan self-service, lihat
   * komentar kelas di atas). `rateLimitOverridePerMinute: null` di
   * body menghapus override (kembali ke tier plan tenant). Pola audit
   * sama seperti `TenantController.updateStatus`/`updatePlan` (T2/T3):
   * dicatat termasuk untuk PATCH yang tidak mengubah nilai.
   */
  updateRateLimitOverride = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const input = updateApiKeyRateLimitOverrideSchema.parse(req.body);
    const { apiKey, previousValue } = await this.apiKeyService.updateRateLimitOverride(
      req.params.id,
      input.rateLimitOverridePerMinute
    );

    await this.auditService.logUpdate(
      'ApiKey',
      apiKey.id,
      { userId: user.id, ipAddress: getClientIp(req), userAgent: getUserAgent(req) },
      {
        field: 'rateLimitOverridePerMinute',
        from: previousValue,
        to: apiKey.rateLimitOverridePerMinute,
      }
    );

    sendSuccess(res, 200, 'Override kuota API key berhasil diperbarui', {
      id: apiKey.id,
      rateLimitOverridePerMinute: apiKey.rateLimitOverridePerMinute,
    });
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
