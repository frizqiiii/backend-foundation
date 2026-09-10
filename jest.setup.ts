/**
 * Dijalankan oleh Jest SEBELUM test file di-load (lihat `setupFiles`
 * di jest.config.ts). Karena `src/shared/config/env.ts` memvalidasi
 * `process.env` secara eager (fail-fast) saat di-import, unit test
 * butuh env dummy ini agar tidak bergantung pada file `.env` asli
 * ataupun koneksi database sungguhan.
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';
process.env.BCRYPT_SALT_ROUNDS = '10';
process.env.JWT_SECRET = 'test-secret-key';
process.env.JWT_EXPIRES_IN = '1d';
// Phase 12 — dummy key HANYA untuk test, 32 byte valid (lihat validasi
// panjang di `env.ts`). TIDAK dipakai untuk data sungguhan mana pun.
process.env.ENCRYPTION_KEY = 'EszJbBLfVmT7QAgKrX5w0jl1EnBU4mowGIAjXmE2krg=';
process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCESS_KEY_ID = 'test-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-access-key';
process.env.AWS_S3_BUCKET_NAME = 'test-bucket';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
// Finding #11 (P0-lanjutan) — SEBELUMNYA `REDIS_URL`/`REDIS_CLUSTER_NODES`
// TIDAK di-stub di sini seperti env var lain di atas. Karena `env.ts`
// me-load `.env` lewat `dotenv/config`, dan `dotenv` TIDAK menimpa
// env var yang sudah ter-set — tapi keduanya tidak pernah ter-set duluan
// di sini — nilai dari `.env` ASLI milik developer (`REDIS_URL=
// "redis://localhost:6379"`, contoh di `.env.example`) BOCOR masuk ke
// setiap test run. Akibatnya `redisClient`/`queueConnection` jadi
// instance Redis SUNGGUHAN (bukan `null` seperti diasumsikan banyak
// test — lihat `email.queue.spec.ts`, `webhook-delivery.queue.spec.ts`,
// `notification.queue.spec.ts`, `login-attempt-tracker.spec.ts`), lalu
// mencoba konek ke Redis yang belum tentu berjalan di mesin developer
// -> "Connection is closed" beruntun yang membuat rate-limiter/session
// middleware ikut gagal dan men-500-kan HAMPIR SELURUH test HTTP di
// `app.integration.spec.ts`/`app.e2e.spec.ts`. String kosong (`''`)
// dipakai karena itu PERSIS default schema `env.ts`
// (`REDIS_URL: str({ default: '' })`) yang membuat `buildRedisClient()`
// mengembalikan `null` — unit/integration test project ini memang
// didesain berjalan TANPA Redis sungguhan.
process.env.REDIS_URL = '';
process.env.REDIS_CLUSTER_NODES = '';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GITHUB_CLIENT_ID = 'test-github-client-id';
process.env.GITHUB_CLIENT_SECRET = 'test-github-client-secret';
