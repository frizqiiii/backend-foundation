import { Verifier } from '@pact-foundation/pact';
import path from 'path';
import bcrypt from 'bcrypt';
import { createApp } from '../../app';
import { prisma } from '../../shared/config/database';

/**
 * Contract Testing (Phase 21 — Enterprise Quality) — Pact PROVIDER
 * verification. Backend ini berperan sebagai *provider*; pact file
 * di `pacts/frontend-web-backend-foundation.json` merepresentasikan
 * ekspektasi SATU *consumer* (`frontend-web`) terhadap
 * `POST /auth/login`.
 *
 * KEJUJURAN SOAL KETERBATASAN INI (bukan terlewat, penting dibaca
 * sebelum dipakai):
 * 1. **Pact file di sini DITULIS TANGAN**, BUKAN digenerate dari
 *    consumer test sungguhan — pola contract testing yang BENAR
 *    (consumer-driven) mengharuskan TIM FRONTEND yang menulis
 *    consumer test yang menghasilkan pact file ini (lewat
 *    `@pact-foundation/pact` versi consumer, atau publish ke Pact
 *    Broker) — proyek ini belum punya consumer/frontend sungguhan di
 *    repository yang sama, jadi file itu murni CONTOH bentuk
 *    kontraknya seperti apa, bukan kontrak yang sudah disepakati tim
 *    lain.
 * 2. **Test ini butuh koneksi database SUNGGUHAN** (`prisma` yang
 *    diimpor di atas TIDAK di-mock sama sekali, beda dari SELURUH
 *    test lain di aplikasi ini) — `stateHandlers` di bawah benar-
 *    benar men-INSERT/DELETE baris `User` di database yang
 *    `DATABASE_URL` tunjuk saat test dijalankan. JANGAN jalankan
 *    lewat `npm test` biasa (memang sudah dikecualikan lewat
 *    `testPathIgnorePatterns` di `jest.config.ts`) atau ke database
 *    production — pakai database test khusus.
 *
 * Jalankan: `npm run test:contract` (butuh `DATABASE_URL` mengarah
 * ke database test yang bisa ditulis, server API TIDAK perlu dinyalakan
 * manual — `Verifier` di bawah menyalakannya sendiri di port acak).
 */
describe('Pact Provider Verification — backend-foundation', () => {
  const TEST_EMAIL = 'login-contract@example.com';
  const TEST_PASSWORD = 'Password123';
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let port: number;

  beforeAll((done) => {
    const app = createApp();
    server = app.listen(0, () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      done();
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  it('memenuhi seluruh interaksi di pact file frontend-web', async () => {
    const verifier = new Verifier({
      provider: 'backend-foundation',
      providerBaseUrl: `http://localhost:${port}`,
      pactUrls: [path.resolve(__dirname, '../../../pacts/frontend-web-backend-foundation.json')],
      stateHandlers: {
        'seorang user dengan email login-contract@example.com sudah terdaftar, terverifikasi, dan password-nya Password123':
          async () => {
            await seedVerifiedUser();
          },
        'seorang user dengan email login-contract@example.com sudah terdaftar dan terverifikasi':
          async () => {
            await seedVerifiedUser();
          },
      },
    });

    await verifier.verifyProvider();
  }, 30_000);

  async function seedVerifiedUser(): Promise<void> {
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        name: 'Contract Test User',
        password: await bcrypt.hash(TEST_PASSWORD, 10),
        role: 'USER',
        emailVerifiedAt: new Date(),
      },
    });
  }
});
