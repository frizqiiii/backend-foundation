import { z } from 'zod';

/**
 * Konfigurasi SSO per tenant — dibuat/diperbarui admin platform.
 * `clientSecret` di sini SELALU plaintext dari admin (baru
 * dienkripsi di Service layer sebelum disimpan) — TIDAK PERNAH
 * dikembalikan lagi lewat response API manapun setelah ini (lihat
 * `SsoConnectionService.get`, yang sengaja tidak mengembalikan field
 * ini sama sekali, bahkan dalam bentuk terenkripsi).
 */
export const upsertSsoConnectionSchema = z.object({
  issuerUrl: z
    .string()
    .url('issuerUrl harus URL valid, mis. https://login.microsoftonline.com/<tenant>/v2.0'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  // Domain SAJA (bukan email lengkap) — mis. "acme.com", dipakai
  // untuk mencocokkan bagian setelah "@" di email dari klaim OIDC.
  allowedEmailDomain: z
    .string()
    .min(3)
    .regex(
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
      'allowedEmailDomain harus berupa domain valid, mis. "acme.com" (tanpa "@" atau path)'
    ),
  enabled: z.boolean().default(true),
});

export type UpsertSsoConnectionDto = z.infer<typeof upsertSsoConnectionSchema>;

/**
 * Query string yang dikirim IdP saat redirect kembali ke
 * `/auth/sso/:tenantSlug/callback` — bentuk standar OAuth2/OIDC
 * authorization code flow. `error`/`error_description` HADIR kalau
 * user membatalkan consent di sisi IdP atau IdP menolak request-nya
 * sendiri (lihat penanganannya di `SsoController.callback`) — bukan
 * error di sisi aplikasi ini.
 */
export const ssoCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().min(1, 'Parameter state wajib ada (perlindungan CSRF/replay)'),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export type SsoCallbackQueryDto = z.infer<typeof ssoCallbackQuerySchema>;

/**
 * Body untuk `POST /auth/sso/consume` — menukar kode sekali-pakai
 * (dari redirect `SSO_FRONTEND_CALLBACK_URL?code=...`) dengan
 * access+refresh token sungguhan. Lihat komentar `SSO_FRONTEND_CALLBACK_URL`
 * di `env.ts` untuk alasan kenapa token tidak langsung ditaruh di URL.
 */
export const consumeSsoCodeSchema = z.object({
  code: z.string().min(1),
});

export type ConsumeSsoCodeDto = z.infer<typeof consumeSsoCodeSchema>;
