import request from 'supertest';
import { mockDeep } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import type { Application } from 'express';

/**
 * Temuan T7 — KONTRAK EKSTERNAL yang dibekukan: URL callback SSO.
 *
 * `SsoService` mengirim `redirect_uri = {APP_BASE_URL}/api/v1/auth/sso/:tenantSlug/callback` ke identity
 * provider (IdP) tiap tenant, dan IdP hanya mau mengembalikan pengguna ke URL yang SUDAH DIDAFTARKAN
 * admin tenant itu di konsol IdP-nya (Okta, Azure AD, dst.). URL itu tidak bisa kita ubah sepihak: mengubah
 * atau mematikan path-nya berarti SEMUA tenant SSO gagal login sampai masing-masing admin mendaftarkan URL
 * baru di IdP. Lihat `docs/api-versioning.md` bagian 2.6.
 *
 * Test ini mengunci dua hal yang bisa rusak diam-diam:
 *  1. path yang DIKIRIM ke IdP tidak berubah (mis. ikut "dinaikkan" ke /api/v2 saat refactor versi), dan
 *  2. path itu benar-benar DILAYANI aplikasi (mis. router /api/v1 dimatikan saat sunset v1 tanpa
 *     mempertahankan path beku ini).
 * Kalau test ini gagal, JANGAN langsung mengubah test-nya: putuskan dulu bagaimana tenant SSO yang ada
 * dimigrasikan.
 */
jest.mock('./shared/config/database', () => {
  const prismaMockInstance = mockDeep<PrismaClient>();
  return { prisma: prismaMockInstance, prismaRead: prismaMockInstance };
});

jest.setTimeout(30_000);

function buildApp(): { app: Application; redirectPath: (slug: string) => string } {
  let result!: { app: Application; redirectPath: (slug: string) => string };
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const appModule = require('./app') as typeof import('./app');
    const ssoModule =
      require('./modules/auth/sso.service') as typeof import('./modules/auth/sso.service');
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */

    // `buildRedirectUri` privat dan hanya memakai `env` — dipanggil lewat prototype
    // (tanpa konstruktor/dependensi) karena ini persis fungsi yang menentukan URL ke IdP.
    const buildRedirectUri = (
      ssoModule.SsoService.prototype as unknown as { buildRedirectUri: (slug: string) => string }
    ).buildRedirectUri;

    result = {
      app: appModule.createApp(),
      redirectPath: (slug) => new URL(buildRedirectUri.call({}, slug)).pathname,
    };
  });
  return result;
}

/** Response dari route yang TERPASANG lewat `errorHandler`/`res.redirect`; route yang tidak ada = 404 HTML bawaan Express. */
function isServedByApp(res: request.Response): boolean {
  return res.status === 302 || /json/.test(String(res.headers['content-type'] ?? ''));
}

describe('Kontrak eksternal beku: URL callback SSO (temuan T7)', () => {
  it('path yang dikirim ke IdP adalah persis /api/v1/auth/sso/:tenantSlug/callback (dibekukan)', () => {
    const { redirectPath } = buildApp();

    expect(redirectPath('acme')).toBe('/api/v1/auth/sso/acme/callback');
    expect(redirectPath('globex-corp')).toBe('/api/v1/auth/sso/globex-corp/callback');
  });

  it('path itu benar-benar DILAYANI aplikasi (bukan 404 bawaan Express) — apa pun yang kita kirim ke IdP harus bisa menerima callback-nya', async () => {
    const { app, redirectPath } = buildApp();

    const res = await request(app).get(redirectPath('acme'));

    expect(isServedByApp(res)).toBe(true);
  });

  it('kontrol negatif: path sejenis yang TIDAK terpasang memang 404 HTML bawaan Express (jadi pemeriksaan di atas benar-benar membedakan)', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/v1/auth/sso/acme/tidak-ada');

    expect(res.status).toBe(404);
    expect(isServedByApp(res)).toBe(false);
  });
});
