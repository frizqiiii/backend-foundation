import crypto from 'crypto';
import request from 'supertest';
import { mockDeep } from 'jest-mock-extended';
import type { DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import type { Application } from 'express';
import { TENANT_HEADER_NAME } from './shared/tenant/tenant.constants';

/**
 * Fase 2 (item 2.13 — i18n) — integration test end-to-end: `createApp()`
 * sungguhan lewat `supertest`, Prisma di-mock (pola sama dengan
 * `app.api-key-ip-limit.integration.spec.ts`). Membuktikan seluruh
 * rantai `Accept-Language` -> `localeMiddleware` -> `res.locals` ->
 * `errorHandler` / `sendSuccess`, termasuk error yang dilempar
 * middleware global SEBELUM router `/api/v1` (tenant).
 */
jest.mock('./shared/config/database', () => {
  const prismaMockInstance = mockDeep<PrismaClient>();
  return { prisma: prismaMockInstance, prismaRead: prismaMockInstance };
});

jest.setTimeout(60_000);

const VALID_KEY = 'bfk_kunci_valid_untuk_test_i18n';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildApp(): Application {
  let app!: Application;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const database =
      require('./shared/config/database') as typeof import('./shared/config/database');
    const appModule = require('./app') as typeof import('./app');
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const prismaMock = database.prisma as unknown as DeepMockProxy<PrismaClient>;

    prismaMock.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return arg(prismaMock);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });
    prismaMock.apiKey.findUnique.mockImplementation(((args: { where: { keyHash: string } }) =>
      Promise.resolve(
        args.where.keyHash === sha256(VALID_KEY)
          ? {
              id: 'key-1',
              userId: 'user-1',
              tenantId: null,
              name: 'partner',
              keyPrefix: 'bfk_kunci',
              keyHash: args.where.keyHash,
              scopes: [],
              lastUsedAt: null,
              expiresAt: null,
              revokedAt: null,
              createdAt: new Date(),
            }
          : null
      )) as never);
    prismaMock.apiKey.update.mockResolvedValue({} as never);
    prismaMock.apiKey.findMany.mockResolvedValue([]);
    prismaMock.user.findFirst.mockResolvedValue({
      id: 'user-1',
      email: 'partner@example.com',
      role: 'USER',
    } as never);
    // Tenant apa pun yang diminta lewat header dianggap tidak ada.
    prismaMock.tenant.findFirst.mockResolvedValue(null);

    app = appModule.createApp();
  });
  return app;
}

describe('Integration: i18n pesan respons API (item 2.13)', () => {
  const app = buildApp();

  describe('error autentikasi (HttpError dari authMiddleware)', () => {
    it('tanpa Accept-Language -> Indonesia (default), Content-Language: id, Vary memuat Accept-Language', async () => {
      const res = await request(app).get('/api/v1/api-keys');

      expect(res.status).toBe(401);
      expect(res.body.message).toBe(
        'Token tidak ditemukan. Sertakan header Authorization: Bearer <token>'
      );
      expect(res.headers['content-language']).toBe('id');
      expect(res.headers.vary).toMatch(/Accept-Language/i);
    });

    it('Accept-Language: en-US,en;q=0.9 -> Inggris, status code sama, Content-Language: en', async () => {
      const res = await request(app)
        .get('/api/v1/api-keys')
        .set('Accept-Language', 'en-US,en;q=0.9');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe(
        'Token not found. Include the header Authorization: Bearer <token>'
      );
      expect(res.headers['content-language']).toBe('en');
    });

    it('bahasa yang tidak didukung (fr) -> jatuh ke Indonesia, bukan error', async () => {
      const res = await request(app)
        .get('/api/v1/api-keys')
        .set('Accept-Language', 'fr-FR,fr;q=0.9');

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/^Token tidak ditemukan/);
      expect(res.headers['content-language']).toBe('id');
    });
  });

  describe('respons sukses (sendSuccess)', () => {
    it('Indonesia (default) dan Inggris untuk endpoint yang sama, data tidak berubah', async () => {
      const idRes = await request(app)
        .get('/api/v1/api-keys')
        .set('Authorization', `Bearer ${VALID_KEY}`);
      const enRes = await request(app)
        .get('/api/v1/api-keys')
        .set('Authorization', `Bearer ${VALID_KEY}`)
        .set('Accept-Language', 'en');

      expect(idRes.status).toBe(200);
      expect(idRes.body.message).toBe('Daftar API key berhasil diambil');
      expect(enRes.status).toBe(200);
      expect(enRes.body.message).toBe('API key list retrieved successfully');
      expect(enRes.body.data).toEqual(idRes.body.data);
    });
  });

  describe('validasi Zod (422)', () => {
    it('pesan per-field mengikuti locale; `message` envelope dan struktur `errors` tetap', async () => {
      const body = { email: 'bukan-email', password: '' };

      const idRes = await request(app).post('/api/v1/auth/login').send(body);
      const enRes = await request(app)
        .post('/api/v1/auth/login')
        .set('Accept-Language', 'en')
        .send(body);

      expect(idRes.status).toBe(422);
      expect(idRes.body.errors.email).toContain('Format email tidak valid');
      expect(enRes.status).toBe(422);
      expect(enRes.body.message).toBe('Validation failed');
      expect(enRes.body.errors.email).toContain('Invalid email format');
      expect(enRes.body.errors.password).toContain('Password is required');
    });
  });

  describe('error dari middleware GLOBAL sebelum router /api/v1 (tenant)', () => {
    it('pesan dinamis (nama tenant di dalam pesan) diterjemahkan dan nilainya terbawa', async () => {
      const idRes = await request(app).get('/api/v1/api-keys').set(TENANT_HEADER_NAME, 'tidak-ada');
      const enRes = await request(app)
        .get('/api/v1/api-keys')
        .set(TENANT_HEADER_NAME, 'tidak-ada')
        .set('Accept-Language', 'en');

      expect(idRes.status).toBe(403);
      expect(idRes.body.message).toBe('Tenant "tidak-ada" tidak ditemukan atau sedang tidak aktif');
      expect(enRes.status).toBe(403);
      expect(enRes.body.message).toBe('Tenant "tidak-ada" was not found or is inactive');
      expect(enRes.headers['content-language']).toBe('en');
    });
  });
});
