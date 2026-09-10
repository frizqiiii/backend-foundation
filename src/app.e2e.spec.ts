import request from 'supertest';
import bcrypt from 'bcrypt';
import { mockDeep, mockReset } from 'jest-mock-extended';
import type { DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient, User } from '@prisma/client';

/**
 * End-to-End test (Phase 4) — beda tujuan dari `app.integration.spec.ts`
 * yang menguji satu flow SEMPIT per describe (mis. hanya Auth, atau
 * hanya Event). Di sini kita mensimulasikan SATU perjalanan pengguna
 * nyata secara berurutan, dari awal sampai akhir, persis seperti yang
 * benar-benar akan dilakukan seseorang membuka aplikasi:
 *
 *   Register -> Login -> Create Event -> Upload File -> Logout
 *
 * Setiap langkah memakai hasil (token, id) dari langkah sebelumnya —
 * kalau ada satu langkah yang diam-diam rusak (mis. `accessToken`
 * hasil login ternyata tidak valid untuk endpoint lain), test ini
 * akan gagal di langkah SETELAHNYA, bukan cuma di langkahnya sendiri.
 *
 * Prisma & S3 di-mock — pola identik dengan `app.integration.spec.ts`.
 */
jest.mock('./shared/config/database', () => {
  const prismaMockInstance = mockDeep<PrismaClient>();
  // Phase 14 — lihat komentar lengkap di app.integration.spec.ts.
  return { prisma: prismaMockInstance, prismaRead: prismaMockInstance };
});

jest.mock('./shared/config/s3', () => ({
  s3Client: { send: jest.fn() },
}));

import { prisma } from './shared/config/database';
import { s3Client } from './shared/config/s3';
import { createApp } from './app';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockedS3Send = s3Client.send as jest.Mock;
const app = createApp();

beforeEach(() => {
  mockReset(prismaMock);
  mockedS3Send.mockReset();
  mockedS3Send.mockResolvedValue({});
  prismaMock.blacklistedToken.findUnique.mockResolvedValue(null);
});

describe('E2E: perjalanan pengguna nyata (Register -> Login -> Create Event -> Upload -> Logout)', () => {
  it('seluruh alur berhasil dari awal sampai akhir, TANPA ada langkah yang gagal', async () => {
    const plainPassword = 'Password123';
    const hashedPassword = bcrypt.hashSync(plainPassword, 4);
    const newUserId = 'user-e2e-1';

    // 1. REGISTER — akun ORGANIZER (supaya bisa lanjut membuat event
    // di langkah 3; kalau USER biasa, langkah itu akan sengaja
    // ditolak 403 oleh RBAC, di luar cakupan skenario "berhasil" ini).
    prismaMock.user.findFirst.mockResolvedValueOnce(null); // belum ada user dengan email ini
    prismaMock.user.create.mockResolvedValueOnce({
      id: newUserId,
      email: 'pengguna-e2e@example.com',
      password: hashedPassword,
      name: 'Pengguna E2E',
      role: 'ORGANIZER',
      emailVerifiedAt: new Date(), // langsung terverifikasi untuk skenario ini
      createdAt: new Date(),
      deletedAt: null,
      tenantId: null,
      mfaEnabled: false,
      mfaSecret: null,
      mfaEnabledAt: null,
    });

    const registerResponse = await request(app).post('/api/v1/auth/register').send({
      name: 'Pengguna E2E',
      email: 'pengguna-e2e@example.com',
      password: plainPassword,
    });

    expect(registerResponse.status).toBe(201);

    // 2. LOGIN — dengan akun yang baru saja dibuat.
    // Diketik eksplisit sebagai `User` (bukan dibiarkan inferred)
    // supaya `role: 'ORGANIZER'` di-cek terhadap enum `Role` Prisma —
    // tanpa ini, TypeScript men-widen jadi `string` biasa karena
    // objek literal ditugaskan ke `const` dulu sebelum dipakai
    // (beda dari `prismaMock.user.create.mockResolvedValueOnce({...})`
    // di atas, yang dapat context type langsung dari parameter mock).
    const dbUser: User = {
      id: newUserId,
      email: 'pengguna-e2e@example.com',
      password: hashedPassword,
      name: 'Pengguna E2E',
      role: 'ORGANIZER',
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      deletedAt: null,
      tenantId: null,
      mfaEnabled: false,
      mfaSecret: null,
      mfaEnabledAt: null,
    };
    prismaMock.user.findFirst.mockResolvedValueOnce(dbUser);
    prismaMock.refreshToken.create.mockResolvedValueOnce({} as never);

    const loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: dbUser.email, password: plainPassword });

    expect(loginResponse.status).toBe(200);
    const { accessToken, refreshToken } = loginResponse.body.data;
    expect(typeof accessToken).toBe('string');

    // 3. CREATE EVENT — dengan accessToken sungguhan hasil login di
    // atas (bukan token yang ditandatangani manual seperti di
    // integration test RBAC — di sini kita membuktikan token yang
    // BENAR-BENAR diterbitkan alur login bisa dipakai end-to-end).
    prismaMock.event.create.mockResolvedValueOnce({
      id: 'event-e2e-1',
      title: 'Konser E2E',
      description: null,
      category: 'Musik',
      location: 'Jakarta',
      date: new Date('2026-12-31T19:00:00.000Z'),
      ownerId: newUserId,
      tenantId: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const createEventResponse = await request(app)
      .post('/api/v1/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Konser E2E',
        category: 'Musik',
        location: 'Jakarta',
        date: '2026-12-31T19:00:00.000Z',
      });

    expect(createEventResponse.status).toBe(201);
    const createdEventId = createEventResponse.body.data.id;

    // 4. UPLOAD FILE — mis. poster untuk event yang baru dibuat.
    prismaMock.fileUpload.create.mockResolvedValueOnce({
      id: 'upload-e2e-1',
      key: 'uploads/poster-e2e.png',
      url: 'https://test-bucket.s3.ap-southeast-1.amazonaws.com/uploads/poster-e2e.png',
      originalName: 'poster.png',
      mimetype: 'image/png',
      sizeBytes: 20,
      userId: newUserId,
      createdAt: new Date(),
    });

    // Finding #18 — sejak `UploadService` memvalidasi magic bytes,
    // buffer di sini HARUS byte PNG asli.
    const realPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const uploadResponse = await request(app)
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', realPngBytes, 'poster.png');

    expect(uploadResponse.status).toBe(201);
    expect(mockedS3Send).toHaveBeenCalledTimes(1); // PutObjectCommand

    // 5. LOGOUT — mengakhiri sesi menggunakan refreshToken hasil login.
    prismaMock.refreshToken.findUnique.mockResolvedValueOnce(null);
    prismaMock.blacklistedToken.create.mockResolvedValueOnce({} as never);

    const logoutResponse = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });

    expect(logoutResponse.status).toBe(200);

    // Bukti akhir: seluruh alur benar-benar melewati SEMUA langkah
    // yang diharapkan, bukan berhenti diam-diam di tengah.
    expect(createdEventId).toBe('event-e2e-1');
  });
});
