import type { Request, Response } from 'express';
import type { PrivacyService } from './privacy.service';
import { requestSelfErasureSchema } from './privacy.dto';
import { sendSuccess } from '../../shared/utils/response';
import { UnauthorizedError } from '../../shared/utils/http-error';

/**
 * Fase 2 — Data retention & GDPR erasure. Dua jalur SENGAJA
 * dipisahkan (bukan satu endpoint dengan flag admin): `eraseSelf`
 * beroperasi HANYA pada `req.user` (tidak pernah menerima id dari
 * luar) dan mewajibkan konfirmasi password; `eraseByAdmin` menerima
 * `:id` dari path dan di belakang permission `user.manage` — pola
 * pemisahan yang sama dengan `MfaController` (murni self-service)
 * vs `TenantController` (murni admin lintas user).
 */
export class PrivacyController {
  constructor(private readonly privacyService: PrivacyService) {}

  eraseSelf = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    const input = requestSelfErasureSchema.parse(req.body);
    const result = await this.privacyService.requestSelfErasure(req.user.id, input.password);
    sendSuccess(res, 200, 'Data pribadi Anda berhasil dihapus permanen', result);
  };

  eraseByAdmin = async (req: Request, res: Response): Promise<void> => {
    const result = await this.privacyService.eraseForUser(req.params.id);
    sendSuccess(res, 200, 'Data pribadi user berhasil dihapus permanen', result);
  };
}
