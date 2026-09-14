/**
 * Setup KHUSUS untuk `rls-bypass.e2e.spec.ts` — SATU-SATUNYA test di
 * project ini yang butuh koneksi database SUNGGUHAN (bukan mock,
 * lihat komentar di file spec-nya sendiri). Salinan `jest.setup.ts`,
 * TAPI `DATABASE_URL` diarahkan ke database TERPISAH khusus test ini
 * — BUKAN database development asli, BUKAN `test_db` dummy yang
 * dipakai `jest.setup.ts` biasa (yang tidak pernah benar-benar
 * dikoneksikan) — supaya data yang dibuat/dihapus berulang kali oleh
 * test RLS ini tidak PERNAH bersentuhan dengan data development asli.
 *
 * PRASYARAT (jalankan MANUAL, sekali, sebelum test ini pernah
 * dijalankan pertama kali di komputer kamu):
 *
 *   createdb -U <user_postgres_anda> backend_foundation_rls_test
 *
 * Lalu jalankan migration KHUSUS ke database itu (JANGAN pakai
 * `DATABASE_URL` development kamu untuk perintah ini):
 *
 *   set DATABASE_URL=postgresql://<user>:<password>@localhost:<port>/backend_foundation_rls_test
 *   npx prisma migrate deploy
 *
 * (di PowerShell: `$env:DATABASE_URL = "..."` alih-alih `set`)
 *
 * Sesuaikan `postgres:postgres@localhost:5432` di bawah kalau
 * user/password/port Postgres kamu berbeda — atau override lewat
 * environment variable `RLS_TEST_DATABASE_URL` tanpa mengedit file
 * ini (mis. `set RLS_TEST_DATABASE_URL=... && npm run test:rls`).
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL =
  process.env.RLS_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/backend_foundation_rls_test';
process.env.BCRYPT_SALT_ROUNDS = '10';
process.env.JWT_SECRET = 'test-secret-key';
process.env.JWT_EXPIRES_IN = '1d';
process.env.ENCRYPTION_KEY = 'EszJbBLfVmT7QAgKrX5w0jl1EnBU4mowGIAjXmE2krg=';
process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCESS_KEY_ID = 'test-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-access-key';
process.env.AWS_S3_BUCKET_NAME = 'test-bucket';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
// Sama seperti jest.setup.ts biasa — test ini tidak butuh Redis sama
// sekali, string kosong membuat buildRedisClient() mengembalikan null.
process.env.REDIS_URL = '';
process.env.REDIS_CLUSTER_NODES = '';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GITHUB_CLIENT_ID = 'test-github-client-id';
process.env.GITHUB_CLIENT_SECRET = 'test-github-client-secret';
