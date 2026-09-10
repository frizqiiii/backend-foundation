import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { mockDeep, mockReset } from 'jest-mock-extended';
import type { DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient, User } from '@prisma/client';
import type { Application } from 'express';
import { TENANT_HEADER_NAME } from './shared/tenant/tenant.constants';

/**
 * Integration test — beda tujuan dari `*.service.spec.ts` (unit test
 * per Service dengan Repository di-mock manual). Di sini kita
 * menjalankan `createApp()` SUNGGUHAN lewat `supertest`: routing,
 * urutan middleware (authMiddleware → requireRole → Controller),
 * validasi Zod, dan `errorHandler` semuanya diuji sebagai satu
 * kesatuan — persis alur yang benar-benar dilalui sebuah HTTP
 * request. Yang di-mock HANYA satu titik: Prisma Client (agar tidak
 * butuh database sungguhan), lewat `jest-mock-extended` supaya bentuk
 * mock otomatis mengikuti seluruh model di skema tanpa ditulis manual
 * satu per satu.
 *
 * `bcrypt` dan `jsonwebtoken` SENGAJA TIDAK di-mock di sini (beda dari
 * unit test) — memakai implementasi asli membuat skenario seperti
 * "access token kedaluwarsa" bisa diuji end-to-end secara nyata,
 * bukan disimulasikan.
 *
 * Mock instance dibuat DI DALAM factory `jest.mock` (bukan di-refer
 * dari variabel luar) — `jest.mock(...)` di-hoist Jest ke atas semua
 * import dalam file ini, jadi factory-nya berjalan SEBELUM statement
 * `const` biasa di luar sempat dieksekusi. Setelah itu, `prisma` yang
 * sudah ter-mock di-import ulang seperti biasa dan di-cast ke
 * `DeepMockProxy` supaya bisa dipakai `.mockResolvedValueOnce(...)`.
 */
jest.mock('./shared/config/database', () => {
  const prismaMockInstance = mockDeep<PrismaClient>();
  // Phase 14 — `prismaRead` di production bisa jadi instance TERPISAH
  // (kalau `DATABASE_REPLICA_URL` dikonfigurasi), tapi untuk test ini
  // cukup mock YANG SAMA dengan `prisma` — integration test di sini
  // tidak menguji replication lag/read-write splitting itu sendiri
  // (itu kualitas infrastruktur, di luar cakupan unit/integration
  // test), hanya memastikan kode yang memanggil `prismaRead` tetap
  // berfungsi seperti memanggil `prisma` biasa.
  return { prisma: prismaMockInstance, prismaRead: prismaMockInstance };
});

// Phase 4 upgrade (Upload flow) — sama alasannya seperti Prisma di
// atas: S3 di-mock supaya test "Upload → Access → Delete" tidak
// pernah benar-benar memanggil AWS.
jest.mock('./shared/config/s3', () => ({
  s3Client: { send: jest.fn() },
}));

import { prisma } from './shared/config/database';
import { s3Client } from './shared/config/s3';
import { createApp, authRateLimiter } from './app';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockedS3Send = s3Client.send as jest.Mock;
const app = createApp();

/**
 * Finding #12 (test-isolation) — `app` di atas dipakai bersama oleh
 * SEMUA test di file ini (kecuali "Integration: rate limiting" yang
 * SUDAH BENAR mengisolasi diri lewat `jest.isolateModules` — lihat
 * komentar di describe block itu). Karena `authRateLimiter` (limit
 * 10 request/15 menit) adalah singleton di level modul `app.ts`,
 * SETIAP request ke `/api/v1/auth/*` dari puluhan `it()` lain di file
 * ini (register, login, refresh, verify-email, forgot-password, dst)
 * ikut menambah counter yang SAMA — pada titik describe block
 * "Session Management" (menjelang akhir file), jumlah kumulatifnya
 * sudah melebihi 10, jadi seluruh test di situ ikut ke-429 padahal
 * masing-masing seharusnya lolos secara terpisah. `resetKey` (API
 * bawaan `express-rate-limit` v7) dipanggil SEBELUM SETIAP test
 * untuk beberapa bentuk `req.ip` yang mungkin dipakai Express/Node
 * di environment berbeda (IPv4-mapped IPv6 paling umum, tapi
 * `127.0.0.1`/`::1` polos juga mungkin tergantung OS) — memanggil
 * `resetKey` pada key yang tidak punya data adalah no-op aman, jadi
 * tidak masalah kalau salah satu kandidat tidak cocok.
 */
beforeEach(() => {
  authRateLimiter.resetKey('::ffff:127.0.0.1');
  authRateLimiter.resetKey('127.0.0.1');
  authRateLimiter.resetKey('::1');
});

// Rate limiter `/api/auth` adalah singleton di level modul `app.ts` —
// dipakai bersama oleh SEMUA test yang memanggil `createApp()` yang
// sama (variabel `app` di atas). Kalau test di bawah memakai `app`
// yang sama, menghabiskan jatah 10 di sini akan ikut membuat test
// "Auth flow" setelahnya kena 429 juga. Solusinya: `jest.isolateModules`
// memberi registry modul yang benar-benar terpisah, sehingga
// `authRateLimiter` yang dibuat di sini adalah instance BARU, tidak
// berbagi state dengan `app` di atas.
describe('Integration: rate limiting pada /api/auth', () => {
  it('melebihi 10 percobaan dalam window yang sama -> percobaan ke-11 ditolak 429', async () => {
    let isolatedApp!: Application;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports
      const isolatedAppModule = require('./app') as typeof import('./app');
      isolatedApp = isolatedAppModule.createApp();
    });

    // Body sengaja tidak lengkap (422) — cukup untuk menguji rate
    // limiter, yang menghitung SEMUA request ke /api/auth terlepas
    // dari sukses/gagalnya validasi, karena middleware-nya terpasang
    // SEBELUM router auth. Dikirim SATU PER SATU (bukan Promise.all)
    // supaya urutan penghitungan rate limiter deterministik — request
    // konkuren tidak menjamin sampai ke server dalam urutan yang sama.
    const statusCodes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request(isolatedApp).post('/api/v1/auth/login').send({});
      statusCodes.push(response.status);
    }

    expect(statusCodes.slice(0, 10)).not.toContain(429);
    expect(statusCodes[10]).toBe(429);
  });
});

const JWT_SECRET = process.env.JWT_SECRET as string;

/**
 * `Partial<User>` (bukan `Partial<Record<string, unknown>>` seperti
 * sebelumnya) — sebelumnya `role: 'USER'` di objek yang di-return
 * fungsi ini widen jadi `string` biasa (bukan enum `Role`) karena
 * TANPA context type di sini, TypeScript tidak tahu objek literal ini
 * akan dipakai sebagai `User` Prisma. Akibatnya SETIAP pemanggil
 * `buildDbUser()` yang hasilnya di-passing ke
 * `prismaMock.user.findFirst.mockResolvedValueOnce(...)` gagal
 * typecheck (11 error site) begitu Prisma Client benar-benar
 * ter-generate. Dengan return type `User` eksplisit, TypeScript
 * memaksa `role: 'USER'` dicek terhadap enum `Role` di titik
 * definisi ini — SATU tempat, bukan di 11 titik pemanggilan.
 */
function buildDbUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-123',
    email: 'budi@example.com',
    password: bcrypt.hashSync('Password123', 4), // salt rounds rendah — cukup untuk test, jauh lebih cepat
    name: 'Budi Santoso',
    role: 'USER',
    emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'), // terverifikasi secara default
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    tenantId: null,
    mfaEnabled: false,
    mfaSecret: null,
    mfaEnabledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockReset(prismaMock);
  mockedS3Send.mockReset();
  mockedS3Send.mockResolvedValue({});

  // Default aman: TIDAK ADA token yang di-blacklist, kecuali test
  // tertentu menimpa ini secara eksplisit. Perlu di-set manual karena
  // `jest-mock-extended` mengembalikan `undefined` (bukan `null`)
  // untuk panggilan yang belum dikonfigurasi — sementara
  // `tokenBlacklist.isBlacklisted` memakai `entry !== null`, sehingga
  // `undefined !== null` (true) akan salah membuat SETIAP token
  // dianggap ter-blacklist di semua test rute terproteksi.
  prismaMock.blacklistedToken.findUnique.mockResolvedValue(null);

  /**
   * Finding #14 (test gap) — SEBELUMNYA `prismaMock.$transaction`
   * tidak pernah diberi default implementation. `$transaction`
   * dipakai dengan DUA bentuk berbeda di codebase ini:
   *   1. Bentuk array — `prisma.$transaction([queryA, queryB])`
   *      (event/product/user repository, pola findMany+count).
   *   2. Bentuk callback interaktif —
   *      `prisma.$transaction(async (tx) => {...})`
   *      (`AuthRepository.runInTransaction`, dipakai
   *      `verifyEmail`/`resetPassword`).
   * Tanpa default, `jest-mock-extended` membuat `$transaction`
   * sekadar mock function yang mengembalikan `undefined` tanpa
   * PERNAH memanggil argumennya — untuk bentuk callback, ini berarti
   * seluruh isi transaksi (mis. `userRepository.update(...)` di
   * `verifyEmail`) DIAM-DIAM TIDAK PERNAH DIJALANKAN, padahal
   * response tetap 200 (tidak ada error yang dilempar, cuma
   * `await undefined`). Default di bawah menangani KEDUA bentuk:
   * kalau argumennya function, panggil dengan `prismaMock` sebagai
   * `tx` (transaksi interaktif "berhasil" beroperasi di atas mock
   * yang sama); kalau array, `Promise.all` seperti perilaku asli
   * Prisma. Test yang butuh hasil spesifik (mis. baris
   * `prismaMock.$transaction.mockResolvedValueOnce([[], 0])` di
   * bawah untuk `GET /api/v1/events`) TETAP menang dengan
   * `mockResolvedValueOnce` — ini hanya fallback dasar, bukan
   * pengganti override per-test.
   */
  prismaMock.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return arg(prismaMock);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
});

describe('Integration: Auth flow', () => {
  it('POST /api/v1/auth/register -> 201, success:true, dan tidak membocorkan password di response', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(null);
    prismaMock.user.create.mockResolvedValueOnce(buildDbUser());

    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Budi Santoso',
      email: 'budi@example.com',
      password: 'Password123',
    });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data).not.toHaveProperty('password');
  });

  it('POST /api/v1/auth/register dengan email sudah terdaftar -> 409, success:false', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(buildDbUser());

    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Budi Santoso',
      email: 'budi@example.com',
      password: 'Password123',
    });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
  });

  it('POST /api/v1/auth/register dengan email tidak valid -> 422 (validasi Zod tertangkap errorHandler)', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Budi Santoso',
      email: 'bukan-email',
      password: 'Password123',
    });

    expect(response.status).toBe(422);
    expect(response.body.success).toBe(false);
    expect(response.body.errors).toHaveProperty('email');
    // Repository sama sekali tidak boleh disentuh — validasi gagal
    // sebelum request sampai ke Service/Repository.
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
  });

  it('POST /api/v1/auth/login dengan password salah -> 401', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(buildDbUser());

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'budi@example.com', password: 'password-yang-salah' });

    expect(response.status).toBe(401);
  });

  it('login berhasil lalu bisa mengakses rute terproteksi dengan accessToken yang diterbitkan', async () => {
    const dbUser = buildDbUser();
    prismaMock.user.findFirst.mockResolvedValueOnce(dbUser); // untuk login
    prismaMock.refreshToken.create.mockResolvedValueOnce({} as never);

    const loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: dbUser.email, password: 'Password123' });

    expect(loginResponse.status).toBe(200);
    const { accessToken } = loginResponse.body.data;
    expect(typeof accessToken).toBe('string');

    prismaMock.user.findFirst.mockResolvedValueOnce(dbUser); // untuk GET /me

    const meResponse = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(meResponse.status).toBe(200);
    expect(meResponse.body.data.email).toBe(dbUser.email);
  });

  /**
   * Melengkapi flow Register→Login→Refresh→Logout (Phase 4) — Refresh
   * sebelumnya tidak diuji di integration test sama sekali, padahal
   * ini bagian PALING kompleks dari auth (rotation + reuse detection).
   * Di sini kita hanya membuktikan rotasinya benar-benar terjadi lewat
   * HTTP sungguhan: refresh token LAMA di-revoke (persis satu kali,
   * dengan id yang benar), dan token BARU yang berbeda diterbitkan.
   */
  it('POST /api/v1/auth/refresh -> 200, merotasi refresh token (token lama di-revoke, token baru diterbitkan)', async () => {
    const dbUser = buildDbUser();
    const storedRefreshToken = {
      id: 'refresh-token-1',
      userId: dbUser.id,
      tokenHash: 'irrelevant-hash',
      device: null,
      ipAddress: null,
      userAgent: null,
      familyId: 'family-refresh-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      familySessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    };

    prismaMock.refreshToken.findUnique.mockResolvedValueOnce(storedRefreshToken);
    prismaMock.user.findFirst.mockResolvedValueOnce(dbUser);
    // Finding #19 — rotasi sekarang pakai `updateMany` (ATOMIC,
    // conditional `WHERE revokedAt: null`) lewat
    // `revokeRefreshTokenIfActive`, BUKAN `update` biasa lagi.
    prismaMock.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.refreshToken.create.mockResolvedValueOnce({} as never);

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'refresh-token-mentah-dari-klien' });

    expect(response.status).toBe(200);
    expect(typeof response.body.data.accessToken).toBe('string');
    expect(typeof response.body.data.refreshToken).toBe('string');
    // Token baru harus BEDA dari yang dikirim klien — bukti rotasi,
    // bukan sekadar mengembalikan token yang sama.
    expect(response.body.data.refreshToken).not.toBe('refresh-token-mentah-dari-klien');

    // Token LAMA harus di-revoke (satu kali, id yang benar, DAN
    // bersyarat `revokedAt: null` — bagian dari fix Finding #19)
    // SEBELUM token baru diterbitkan.
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: storedRefreshToken.id, revokedAt: null } })
    );
  });

  it('POST /api/v1/auth/refresh dengan token yang SUDAH di-revoke sebelumnya (reuse) -> 401, DAN mencabut seluruh FAMILY token ini', async () => {
    const dbUser = buildDbUser();
    const reusedToken = {
      id: 'refresh-token-1',
      userId: dbUser.id,
      tokenHash: 'irrelevant-hash',
      familyId: 'family-abc',
      device: null,
      ipAddress: null,
      userAgent: null,
      revokedAt: new Date(), // SUDAH di-revoke sebelumnya — indikasi reuse/pencurian
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      familySessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    };

    prismaMock.refreshToken.findUnique.mockResolvedValueOnce(reusedToken);
    prismaMock.refreshToken.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'refresh-token-yang-dipakai-ulang' });

    expect(response.status).toBe(401);
    // `revokeRefreshTokenFamily` (Phase 9) — HANYA family token ini
    // yang dicabut, bukan seluruh sesi user di semua device (lihat
    // catatan `familyId` di skema Prisma untuk alasan perubahan ini).
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyId: 'family-abc', revokedAt: null } })
    );
  });
});

describe('Integration: email verification menghalangi login', () => {
  it('login ditolak 403 ketika emailVerifiedAt masih null', async () => {
    const unverifiedUser = buildDbUser({ emailVerifiedAt: null });
    prismaMock.user.findFirst.mockResolvedValueOnce(unverifiedUser);

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: unverifiedUser.email, password: 'Password123' });

    expect(response.status).toBe(403);
    expect(response.body.success).toBe(false);
  });
});

describe('Integration: verify-email & forgot-password', () => {
  it('POST /api/v1/auth/verify-email dengan token valid -> 200 dan menandai emailVerifiedAt', async () => {
    prismaMock.emailVerificationToken.findUnique.mockResolvedValueOnce({
      id: 'evt-1',
      tokenHash: 'irrelevant-karena-di-mock',
      userId: 'user-123',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    prismaMock.user.update.mockResolvedValueOnce(buildDbUser());

    const response = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'some-token' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-123' },
      data: { emailVerifiedAt: expect.any(Date) },
    });
  });

  it('POST /api/v1/auth/forgot-password SELALU 200 meski email tidak terdaftar (anti user-enumeration)', async () => {
    prismaMock.user.findFirst.mockResolvedValueOnce(null);

    const response = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'tidak-terdaftar@example.com' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});

describe('Integration: logout benar-benar mem-blacklist access token (end-to-end)', () => {
  it('access token yang sudah dipakai logout ditolak 401 pada request berikutnya', async () => {
    const dbUser = buildDbUser();

    // Login dulu untuk dapat accessToken sungguhan.
    prismaMock.user.findFirst.mockResolvedValueOnce(dbUser);
    prismaMock.refreshToken.create.mockResolvedValueOnce({} as never);
    const loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: dbUser.email, password: 'Password123' });
    const { accessToken, refreshToken } = loginResponse.body.data;

    // Logout — endpoint ini butuh authMiddleware lolos dulu (findUnique
    // untuk blacklist check TIDAK dipakai karena authMiddleware hanya
    // baca tabel blacklist, bukan user).
    prismaMock.refreshToken.findUnique.mockResolvedValueOnce(null); // refreshToken tidak perlu valid untuk buktikan blacklist access token
    prismaMock.blacklistedToken.create.mockResolvedValueOnce({} as never);
    const logoutResponse = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect(logoutResponse.status).toBe(200);

    // Access token YANG SAMA dipakai lagi -> harus ditolak karena
    // sekarang ada di blacklist (jti-nya cocok dengan yang baru saja
    // di-insert lewat blacklistedToken.create di atas).
    prismaMock.blacklistedToken.findUnique.mockResolvedValueOnce({
      id: 'bl-1',
      jti: 'irrelevant',
      userId: dbUser.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    const secondMeResponse = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(secondMeResponse.status).toBe(401);
    expect(secondMeResponse.body.message).toMatch(/dicabut/i);
  });
});

describe('Integration: proteksi authMiddleware', () => {
  it('mengakses rute terproteksi TANPA token -> 401', async () => {
    const response = await request(app).get('/api/v1/users/me');
    expect(response.status).toBe(401);
  });

  it('mengakses rute terproteksi dengan token acak/rusak -> 401', async () => {
    const response = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer token-acak-yang-tidak-valid');

    expect(response.status).toBe(401);
  });

  it('mengakses rute terproteksi dengan access token yang SUDAH KEDALUWARSA -> 401 dengan pesan spesifik', async () => {
    // Token asli (bukan mock) ditandatangani dengan JWT_SECRET yang
    // sama seperti aplikasi, tapi `expiresIn` negatif membuatnya
    // kedaluwarsa SAAT DITERBITKAN — menguji cabang
    // `jwt.TokenExpiredError` di authMiddleware secara nyata.
    const expiredToken = jwt.sign(
      { id: 'user-123', email: 'budi@example.com', role: 'USER' },
      JWT_SECRET,
      {
        expiresIn: '-10s',
      }
    );

    const response = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/kadaluarsa/i);
  });
});

describe('Integration: RBAC (requireRole)', () => {
  function signAccessToken(role: string): string {
    return jwt.sign({ id: 'user-123', email: 'budi@example.com', role }, JWT_SECRET, {
      expiresIn: '15m',
    });
  }

  it('role USER mencoba membuat event -> 403 (bukan ORGANIZER/ADMIN)', async () => {
    const response = await request(app)
      .post('/api/v1/events')
      .set('Authorization', `Bearer ${signAccessToken('USER')}`)
      .send({
        title: 'Event Test',
        category: 'Musik',
        location: 'Bandung',
        date: '2026-12-01T10:00:00.000Z',
      });

    expect(response.status).toBe(403);
  });

  it('role ORGANIZER berhasil membuat event -> 201', async () => {
    prismaMock.event.create.mockResolvedValueOnce({
      id: 'event-123',
      title: 'Event Test',
      description: null,
      category: 'Musik',
      location: 'Bandung',
      date: new Date('2026-12-01T10:00:00.000Z'),
      ownerId: 'user-123',
      tenantId: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(app)
      .post('/api/v1/events')
      .set('Authorization', `Bearer ${signAccessToken('ORGANIZER')}`)
      .send({
        title: 'Event Test',
        category: 'Musik',
        location: 'Bandung',
        date: '2026-12-01T10:00:00.000Z',
      });

    expect(response.status).toBe(201);
  });
});

/**
 * Melengkapi flow Create→Update→Delete (Phase 4) — sebelumnya hanya
 * Create yang diuji lewat HTTP sungguhan. Di sini kepemilikan
 * ditegakkan end-to-end: ORGANIZER yang membuat event, lalu MENGUBAH
 * dan MENGHAPUS event miliknya sendiri lewat request HTTP nyata
 * (bukan panggilan langsung ke `EventService` seperti di unit test).
 */
describe('Integration: Event flow (Update & Delete kepemilikan)', () => {
  const ownerId = 'user-123';
  function signAccessToken(role: string, id = ownerId): string {
    return jwt.sign({ id, email: 'budi@example.com', role }, JWT_SECRET, { expiresIn: '15m' });
  }

  const dbEvent = {
    id: 'event-123',
    title: 'Event Test',
    description: null,
    category: 'Musik',
    location: 'Bandung',
    date: new Date('2026-12-01T10:00:00.000Z'),
    ownerId,
    tenantId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('PATCH /api/v1/events/:id oleh pemilik -> 200, perubahan tersimpan', async () => {
    prismaMock.event.findFirst.mockResolvedValueOnce(dbEvent);
    prismaMock.event.update.mockResolvedValueOnce({ ...dbEvent, title: 'Judul Baru' });

    const response = await request(app)
      .patch(`/api/v1/events/${dbEvent.id}`)
      .set('Authorization', `Bearer ${signAccessToken('ORGANIZER')}`)
      .send({ title: 'Judul Baru' });

    expect(response.status).toBe(200);
    expect(response.body.data.title).toBe('Judul Baru');
  });

  it('PATCH /api/v1/events/:id oleh BUKAN pemilik (dan bukan admin) -> 403', async () => {
    prismaMock.event.findFirst.mockResolvedValueOnce(dbEvent);

    const response = await request(app)
      .patch(`/api/v1/events/${dbEvent.id}`)
      .set('Authorization', `Bearer ${signAccessToken('ORGANIZER', 'user-lain-999')}`)
      .send({ title: 'Judul Baru' });

    expect(response.status).toBe(403);
    expect(prismaMock.event.update).not.toHaveBeenCalled();
  });

  it('DELETE /api/v1/events/:id oleh pemilik -> 200, event benar-benar terhapus (soft delete)', async () => {
    prismaMock.event.findFirst.mockResolvedValueOnce(dbEvent);
    prismaMock.event.update.mockResolvedValueOnce({ ...dbEvent, deletedAt: new Date() });

    const response = await request(app)
      .delete(`/api/v1/events/${dbEvent.id}`)
      .set('Authorization', `Bearer ${signAccessToken('ORGANIZER')}`);

    expect(response.status).toBe(200);
    // Soft delete — `deletedAt` diisi, BUKAN `prisma.event.delete()`.
    expect(prismaMock.event.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: dbEvent.id },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      })
    );
  });
});

/**
 * Regression test untuk P1 Finding #10 — `EventRepository.findById`
 * SEBELUMNYA tidak tenant-scoped (beda dari `findMany`/`create` di
 * repository yang sama), artinya user tenant B yang tahu/menebak
 * UUID event milik tenant A bisa membaca/mengubah/menghapusnya lewat
 * `GET`/`PATCH`/`DELETE /events/:id`. Diuji di sini lewat HTTP
 * sungguhan (bukan panggil `EventRepository` langsung) supaya turut
 * memverifikasi `tenantMiddleware` (Phase 11) benar-benar mengisi
 * tenant context dari header `X-Tenant-ID` sebelum mencapai
 * Controller/Service/Repository.
 */
describe('Integration: Event flow (Isolasi Tenant)', () => {
  const ownerId = 'user-123';
  function signAccessToken(role: string, id = ownerId): string {
    return jwt.sign({ id, email: 'budi@example.com', role }, JWT_SECRET, { expiresIn: '15m' });
  }

  const tenantAcme = {
    id: 'tenant-acme-id',
    slug: 'acme',
    name: 'Acme',
    status: 'ACTIVE' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const dbEvent = {
    id: 'event-123',
    title: 'Event Test',
    description: null,
    category: 'Musik',
    location: 'Bandung',
    date: new Date('2026-12-01T10:00:00.000Z'),
    ownerId,
    // Event ini milik tenant LAIN ('tenant-globex-id'), BUKAN
    // 'tenant-acme-id' yang dipakai request di bawah — persis
    // skenario cross-tenant yang jadi celah sebelum diperbaiki.
    tenantId: 'tenant-globex-id',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('EventRepository.findById menyertakan tenantId di klausa `where` ketika tenant context aktif', async () => {
    prismaMock.tenant.findFirst.mockResolvedValueOnce(tenantAcme);
    prismaMock.event.findFirst.mockResolvedValueOnce(null);

    await request(app)
      .get(`/api/v1/events/${dbEvent.id}`)
      .set(TENANT_HEADER_NAME, 'acme')
      .set('Authorization', `Bearer ${signAccessToken('ORGANIZER')}`);

    expect(prismaMock.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: dbEvent.id, tenantId: tenantAcme.id }),
      })
    );
  });

  it('GET /api/v1/events/:id dengan tenant context aktif untuk event milik TENANT LAIN -> 404 (bukan bocor data)', async () => {
    prismaMock.tenant.findFirst.mockResolvedValueOnce(tenantAcme);
    // `findFirst` yang sudah tenant-scoped akan menghasilkan `null`
    // untuk event tenant lain — inilah efek nyata dari perbaikan di
    // `EventRepository.findById`.
    prismaMock.event.findFirst.mockResolvedValueOnce(null);

    const response = await request(app)
      .get(`/api/v1/events/${dbEvent.id}`)
      .set(TENANT_HEADER_NAME, 'acme')
      .set('Authorization', `Bearer ${signAccessToken('ORGANIZER')}`);

    expect(response.status).toBe(404);
  });

  it('GET /api/v1/events/:id TANPA header tenant (backward compatible) -> tetap bisa mengakses seperti sebelum Phase 11', async () => {
    prismaMock.event.findFirst.mockResolvedValueOnce(dbEvent);

    const response = await request(app)
      .get(`/api/v1/events/${dbEvent.id}`)
      .set('Authorization', `Bearer ${signAccessToken('ORGANIZER')}`);

    expect(response.status).toBe(200);
    expect(prismaMock.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: dbEvent.id, deletedAt: null },
      })
    );
  });
});

/**
 * Flow Upload→Access→Delete (Phase 4) — sebelumnya modul `upload`
 * hanya bisa "Upload" (tidak ada Access/Delete sama sekali). S3
 * di-mock (lihat `jest.mock('./shared/config/s3', ...)` di atas),
 * `multer` (upload.middleware) TIDAK di-mock — `.attach()` supertest
 * mengirim multipart/form-data sungguhan, diproses parser asli.
 */
describe('Integration: Upload flow (Upload -> Access -> Delete)', () => {
  const ownerId = 'user-123';
  function signAccessToken(role: string, id = ownerId): string {
    return jwt.sign({ id, email: 'budi@example.com', role }, JWT_SECRET, { expiresIn: '15m' });
  }

  const dbFileUpload = {
    id: 'upload-1',
    key: 'uploads/abc123.png',
    url: 'https://test-bucket.s3.ap-southeast-1.amazonaws.com/uploads/abc123.png',
    originalName: 'foto.png',
    mimetype: 'image/png',
    sizeBytes: 12,
    userId: ownerId,
    createdAt: new Date(),
  };

  it('POST /api/v1/upload -> 201, DAN mencatat kepemilikan file (userId) di database', async () => {
    prismaMock.fileUpload.create.mockResolvedValueOnce(dbFileUpload);

    // Finding #18 — sejak `UploadService` memvalidasi magic bytes,
    // buffer di sini HARUS byte PNG asli, bukan sekadar teks
    // placeholder ('fake-image-content' sebelumnya) — kalau tidak,
    // request ini akan ditolak 422/400 oleh validasi baru sebelum
    // sempat menguji apa pun yang sebenarnya dites di sini.
    const realPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

    const response = await request(app)
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${signAccessToken('USER')}`)
      .attach('file', realPngBytes, 'foto.png');

    expect(response.status).toBe(201);
    expect(mockedS3Send).toHaveBeenCalledTimes(1);
    expect(prismaMock.fileUpload.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: ownerId }) })
    );
    expect(response.body.data.id).toBe(dbFileUpload.id);
  });

  it('GET /api/v1/upload/:id oleh pemilik -> 200, metadata file', async () => {
    prismaMock.fileUpload.findUnique.mockResolvedValueOnce(dbFileUpload);

    const response = await request(app)
      .get(`/api/v1/upload/${dbFileUpload.id}`)
      .set('Authorization', `Bearer ${signAccessToken('USER')}`);

    expect(response.status).toBe(200);
    expect(response.body.data.originalName).toBe('foto.png');
  });

  it('GET /api/v1/upload/:id oleh BUKAN pemilik (dan bukan admin) -> 403', async () => {
    prismaMock.fileUpload.findUnique.mockResolvedValueOnce(dbFileUpload);

    const response = await request(app)
      .get(`/api/v1/upload/${dbFileUpload.id}`)
      .set('Authorization', `Bearer ${signAccessToken('USER', 'user-lain-999')}`);

    expect(response.status).toBe(403);
  });

  it('DELETE /api/v1/upload/:id oleh pemilik -> 200, DAN menghapus objek S3 dengan Key yang benar', async () => {
    prismaMock.fileUpload.findUnique.mockResolvedValueOnce(dbFileUpload);
    prismaMock.fileUpload.delete.mockResolvedValueOnce(dbFileUpload);

    const response = await request(app)
      .delete(`/api/v1/upload/${dbFileUpload.id}`)
      .set('Authorization', `Bearer ${signAccessToken('USER')}`);

    expect(response.status).toBe(200);
    const deleteCommandArg = mockedS3Send.mock.calls[0][0] as { input: { Key: string } };
    expect(deleteCommandArg.input.Key).toBe(dbFileUpload.key);
    expect(prismaMock.fileUpload.delete).toHaveBeenCalledWith({ where: { id: dbFileUpload.id } });
  });
});

describe('Integration: response envelope', () => {
  it('GET /api/v1/events -> body punya success, message, data, DAN meta pagination', async () => {
    prismaMock.$transaction.mockResolvedValueOnce([[], 0]);

    const response = await request(app).get('/api/v1/events');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      message: 'Daftar event berhasil diambil',
      data: [],
      meta: { page: 1, limit: 10, total: 0, totalPages: 1 },
    });
  });
});

describe('Integration: resource not found', () => {
  it('GET /api/v1/events/:id dengan id yang tidak ada -> 404', async () => {
    prismaMock.event.findFirst.mockResolvedValueOnce(null);

    const response = await request(app).get('/api/v1/events/id-tidak-ada');

    expect(response.status).toBe(404);
  });
});

describe('Integration: CORS whitelist', () => {
  it('request dari origin yang TERDAFTAR -> header CORS diizinkan', async () => {
    prismaMock.event.findFirst.mockResolvedValueOnce(null);

    const response = await request(app)
      .get('/api/v1/events/id-tidak-ada')
      .set('Origin', 'http://localhost:3000'); // sesuai CORS_ALLOWED_ORIGINS di jest.setup.ts

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('request dari origin yang TIDAK terdaftar -> ditolak (403)', async () => {
    const response = await request(app)
      .get('/api/v1/events')
      .set('Origin', 'https://situs-tidak-dikenal.com');

    expect(response.status).toBe(403);
  });

  /**
   * Regression test untuk Finding #16 — SEBELUMNYA `X-Tenant-ID` tidak
   * ada di `allowedHeaders` CORS, jadi browser cross-origin (meski
   * origin-nya SUDAH terdaftar) tidak bisa mengirim header ini sama
   * sekali — preflight OPTIONS akan menolaknya, membuat fitur
   * multi-tenant tidak bisa dipakai dari client SPA cross-origin.
   * Diuji lewat preflight OPTIONS sungguhan (bukan baca konfigurasi),
   * memeriksa `Access-Control-Allow-Headers` benar-benar mengizinkan
   * kedua header custom aplikasi ini.
   */
  it('preflight OPTIONS dari origin TERDAFTAR -> X-Tenant-ID dan X-Correlation-Id diizinkan di Access-Control-Allow-Headers', async () => {
    const response = await request(app)
      .options('/api/v1/events')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'X-Tenant-ID, X-Correlation-Id');

    const allowedHeaders = (response.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowedHeaders).toContain('x-tenant-id');
    expect(allowedHeaders).toContain('x-correlation-id');
  });
});

/**
 * Session Management (Langkah 3 audit) — sebelum ini, ketiga endpoint
 * `/auth/sessions` HANYA diuji lewat `AuthService.spec.ts` (Repository
 * di-mock manual, tidak pernah melalui routing/middleware
 * sungguhan). Blok ini menutup celah itu: menguji lewat `supertest`
 * persis seperti describe lain di file ini, termasuk kepemilikan
 * sesi (403/404 kalau mencoba mencabut sesi milik user lain) yang
 * sebelumnya HANYA dibuktikan benar di level unit test.
 */
describe('Integration: Session Management (/auth/sessions)', () => {
  function signAccessToken(userId: string): string {
    return jwt.sign({ id: userId, email: 'sesi@example.com', role: 'USER' }, JWT_SECRET, {
      expiresIn: '15m',
    });
  }

  function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'session-1',
      tokenHash: 'hash-tidak-relevan',
      userId: 'user-pemilik-sesi',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      revokedAt: null,
      createdAt: new Date(),
      userAgent: 'Mozilla/5.0 (Test)',
      ipAddress: '127.0.0.1',
      familyId: 'family-1',
      ...overrides,
    };
  }

  it('GET /auth/sessions TANPA token -> 401', async () => {
    const response = await request(app).get('/api/v1/auth/sessions');
    expect(response.status).toBe(401);
  });

  it('GET /auth/sessions -> daftar sesi aktif milik user yang login', async () => {
    prismaMock.refreshToken.findMany.mockResolvedValueOnce([makeSession()] as never);

    const response = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${signAccessToken('user-pemilik-sesi')}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].id).toBe('session-1');
  });

  it('DELETE /auth/sessions/:id -> mencabut sesi MILIK SENDIRI, 200', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValueOnce(
      makeSession({ userId: 'user-pemilik-sesi' }) as never
    );
    prismaMock.refreshToken.update.mockResolvedValueOnce(makeSession() as never);

    const response = await request(app)
      .delete('/api/v1/auth/sessions/session-1')
      .set('Authorization', `Bearer ${signAccessToken('user-pemilik-sesi')}`);

    expect(response.status).toBe(200);
    expect(prismaMock.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'session-1' } })
    );
  });

  it('DELETE /auth/sessions/:id -> mencoba mencabut sesi MILIK USER LAIN -> 404 (BUKAN 200)', async () => {
    // Kepemilikan ditegakkan di `AuthService.revokeSession` — baris
    // sesi ADA di database (bukan 404 karena tidak ditemukan sama
    // sekali), tapi `userId`-nya beda dari user yang sedang login.
    // Ini persis skenario IDOR yang harus DITOLAK, diuji di sini
    // lewat routing sungguhan, bukan cuma dipanggil langsung ke
    // Service seperti di unit test.
    prismaMock.refreshToken.findUnique.mockResolvedValueOnce(
      makeSession({ userId: 'user-lain-yang-bukan-pemilik' }) as never
    );

    const response = await request(app)
      .delete('/api/v1/auth/sessions/session-milik-orang-lain')
      .set('Authorization', `Bearer ${signAccessToken('user-pemilik-sesi')}`);

    expect(response.status).toBe(404);
    expect(prismaMock.refreshToken.update).not.toHaveBeenCalled();
  });

  it('DELETE /auth/sessions (revoke all) -> mencabut SELURUH sesi user yang login, 200', async () => {
    prismaMock.refreshToken.updateMany.mockResolvedValueOnce({ count: 3 } as never);

    const response = await request(app)
      .delete('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${signAccessToken('user-pemilik-sesi')}`);

    expect(response.status).toBe(200);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-pemilik-sesi', revokedAt: null } })
    );
  });
});
