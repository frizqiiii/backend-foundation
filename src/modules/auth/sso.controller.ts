import type { Request, Response } from 'express';
import type { SsoConnectionService, SsoService } from './sso.service';
import { upsertSsoConnectionSchema, ssoCallbackQuerySchema, consumeSsoCodeSchema } from './sso.dto';
import { sendSuccess } from '../../shared/utils/response';
import { env } from '../../shared/config/env';
import { BadRequestError, NotFoundError } from '../../shared/utils/http-error';

export class SsoAdminController {
  constructor(private readonly ssoConnectionService: SsoConnectionService) {}

  upsert = async (req: Request, res: Response): Promise<void> => {
    const input = upsertSsoConnectionSchema.parse(req.body);
    const connection = await this.ssoConnectionService.upsert(req.params.tenantSlug, input);
    sendSuccess(res, 200, 'Konfigurasi SSO tenant berhasil disimpan', connection);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const connection = await this.ssoConnectionService.get(req.params.tenantSlug);
    if (!connection) {
      throw new NotFoundError('Tenant ini belum punya konfigurasi SSO');
    }
    sendSuccess(res, 200, 'Konfigurasi SSO tenant berhasil diambil', connection);
  };
}

/**
 * Endpoint PUBLIK (bukan `authMiddleware`) — SENGAJA, sama alasannya
 * dengan `/auth/login` biasa: titik ini terjadi SEBELUM user
 * memiliki access token apa pun, otorisasinya adalah alur redirect
 * OIDC itu sendiri (state+nonce+PKCE), bukan sesi yang sudah login.
 */
export class SsoController {
  constructor(private readonly ssoService: SsoService) {}

  login = async (req: Request, res: Response): Promise<void> => {
    const url = await this.ssoService.buildAuthorizationUrl(req.params.tenantSlug);
    res.redirect(url);
  };

  /**
   * Redirect balik dari IdP. TIDAK PERNAH mengembalikan JSON token
   * langsung dari sini (ini masih request GET hasil redirect
   * top-level browser, bukan panggilan API yang dikendalikan
   * frontend) — selalu redirect LAGI ke `SSO_FRONTEND_CALLBACK_URL`
   * dengan kode tukar sekali-pakai. Lihat komentar lengkap di
   * `env.ts` (`SSO_FRONTEND_CALLBACK_URL`) dan `SsoService.handleCallback`.
   */
  callback = async (req: Request, res: Response): Promise<void> => {
    if (!env.SSO_FRONTEND_CALLBACK_URL) {
      throw new BadRequestError('SSO_FRONTEND_CALLBACK_URL belum dikonfigurasi di server ini.');
    }
    const query = ssoCallbackQuerySchema.parse(req.query);
    const exchangeCode = await this.ssoService.handleCallback(req.params.tenantSlug, query);

    const redirectUrl = new URL(env.SSO_FRONTEND_CALLBACK_URL);
    redirectUrl.searchParams.set('code', exchangeCode);
    res.redirect(redirectUrl.toString());
  };

  consume = async (req: Request, res: Response): Promise<void> => {
    const input = consumeSsoCodeSchema.parse(req.body);
    const result = await this.ssoService.consume(input.code);
    sendSuccess(res, 200, 'Login SSO berhasil', result);
  };
}
