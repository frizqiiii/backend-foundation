import crypto from 'crypto';
import request from 'supertest';
import { mockDeep } from 'jest-mock-extended';
import type { DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import type { Application } from 'express';

/**
 * Fase 2 (temuan T1) — integration test end-to-end: `createApp()`
 * sungguhan lewat `supertest`, Prisma di-mock (pola sama dengan
 * `app.tenant-rate-limit.integration.spec.ts`).
 *
 * Membuktikan bahwa `generalRateLimiter` (per-IP, 300/15 menit)
 * MEMBEBASKAN trafik yang sudah diautentikasi penuh lewat API key
 * yang valid — tapi TIDAK membebaskan apa pun yang lain (JWT/anonim,
 * API key palsu, header `bfk_` yang ditempel di endpoint publik,
 * request ber-key valid yang melampaui kuota per-key-nya).
 *
 * `enforcePartnerApiGatewayLimit` di-mock: gateway sungguhan butuh
 * Redis (fail-open tanpa Redis), sedangkan yang diuji di sini adalah
 * interaksi limiter per-IP dengan HASIL gateway, bukan gateway itu
 * sendiri (sudah punya spec sendiri).
 */
// Status gateway palsu — dibaca di dalam factory `jest.mock` di bawah.
const gatewayState = { overQuota: false, calls: 0 };

jest.mock('./shared/config/database', () => {
  const prismaMockInstance = mockDeep<PrismaClient>();
  return { prisma: prismaMockInstance, prismaRead: prismaMockInstance };
});
jest.mock('./shared/security/api-key-gateway', () => {
  // `TooManyRequestsError` HARUS diambil dari registry modul yang sama
  // dengan `app.ts` (`jest.isolateModules` membuat salinan modul
  // terpisah) — kelas dari registry lain gagal `instanceof` di error
  // handler dan berubah jadi 500. Diambil di sini (saat factory jalan
  // di dalam `isolateModules`), bukan saat request.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TooManyRequestsError } = require('./shared/utils/http-error');
  return {
    enforcePartnerApiGatewayLimit: async (): Promise<void> => {
      gatewayState.calls += 1;
      if (gatewayState.overQuota) {
        throw new TooManyRequestsError('Kuota API key terlampaui');
      }
    },
  };
});

// Ratusan request sekuensial per test + cold start ts-jest.
jest.setTimeout(60_000);

const VALID_KEY = 'bfk_kunci_valid_untuk_test_t1';
const BOGUS_KEY = 'bfk_kunci_palsu_untuk_test_t1';
const IP_LIMIT_MESSAGE = /dari IP ini/;

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

    app = appModule.createApp();
  });
  return app;
}

/** Endpoint ber-`authMiddleware` (daftar API key milik user) — dipakai untuk trafik ber-key. */
function keyed(app: Application, key: string): request.Test {
  return request(app).get('/api/v1/api-keys').set('Authorization', `Bearer ${key}`);
}

/** Path publik (tanpa `authMiddleware`) — 404 biasa, tapi tetap melewati limiter per-IP. */
function publicHit(app: Application, headers: Record<string, string> = {}): request.Test {
  return request(app).get('/api/v1/tidak-ada-endpoint-ini').set(headers);
}

async function collect(total: number, call: () => request.Test): Promise<request.Response[]> {
  const responses: request.Response[] = [];
  for (let i = 0; i < total; i += 1) {
    // Sekuensial supaya urutan penghitungan deterministik.
    // eslint-disable-next-line no-await-in-loop
    responses.push(await call());
  }
  return responses;
}

describe('Integration: limiter per-IP dan API key (temuan T1)', () => {
  beforeEach(() => {
    gatewayState.overQuota = false;
    gatewayState.calls = 0;
  });

  it('API key VALID dari satu IP: 320 request (> 300) tidak ada yang kena limiter per-IP', async () => {
    const app = buildApp();

    const responses = await collect(320, () => keyed(app, VALID_KEY));

    expect(responses.map((r) => r.status)).not.toContain(429);
    expect(responses.every((r) => r.status === 200)).toBe(true);
  });

  it('API key PALSU: tetap dibatasi 300/15 menit per IP (401 sampai batas, lalu 429 "dari IP ini") — perilaku lama tidak berubah', async () => {
    const app = buildApp();

    const responses = await collect(300, () => keyed(app, BOGUS_KEY));
    expect(responses.every((r) => r.status === 401)).toBe(true);

    const blocked = await keyed(app, BOGUS_KEY);
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(IP_LIMIT_MESSAGE);
  });

  it('header `Bearer bfk_...` yang ditempel di endpoint PUBLIK TIDAK memberi pembebasan (celah yang sengaja ditutup: kriterianya hasil autentikasi, bukan header)', async () => {
    const app = buildApp();

    const responses = await collect(300, () =>
      publicHit(app, { Authorization: `Bearer ${VALID_KEY}` })
    );
    expect(responses.every((r) => r.status === 404)).toBe(true);

    const blocked = await publicHit(app, { Authorization: `Bearer ${VALID_KEY}` });
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(IP_LIMIT_MESSAGE);
  });

  it('trafik anonim: tetap 300/15 menit per IP (baseline tidak berubah)', async () => {
    const app = buildApp();

    const responses = await collect(300, () => publicHit(app));
    expect(responses.every((r) => r.status === 404)).toBe(true);

    const blocked = await publicHit(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(IP_LIMIT_MESSAGE);
  });

  it('key valid tapi MELAMPAUI kuota per-key: penolakannya tetap terhitung per-IP (menahan beban lookup DB dari key yang menyalahgunakan kuota)', async () => {
    const app = buildApp();
    gatewayState.overQuota = true;

    const responses = await collect(300, () => keyed(app, VALID_KEY));
    expect(responses.every((r) => r.status === 429)).toBe(true);
    expect(responses.every((r) => !IP_LIMIT_MESSAGE.test(r.body.message))).toBe(true);

    // Hit ke-301 ditolak oleh limiter PER-IP (pesan "dari IP ini"), bukan lagi oleh gateway.
    const blocked = await keyed(app, VALID_KEY);
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(IP_LIMIT_MESSAGE);
    expect(gatewayState.calls).toBe(300);
  });

  it('trafik ber-key valid TIDAK menghabiskan jatah per-IP untuk trafik lain dari IP yang sama', async () => {
    const app = buildApp();

    await collect(250, () => keyed(app, VALID_KEY));

    // Jatah 300 milik IP ini masih utuh untuk trafik non-key.
    const responses = await collect(300, () => publicHit(app));
    expect(responses.every((r) => r.status === 404)).toBe(true);
    expect((await publicHit(app)).status).toBe(429);
  });
});
