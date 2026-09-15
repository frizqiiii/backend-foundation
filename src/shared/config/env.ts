import 'dotenv/config';
import { cleanEnv, str, port, num, bool } from 'envalid';

/**
 * Validasi environment variable di titik masuk aplikasi.
 * Jika ada variable wajib yang hilang/salah format, proses akan
 * langsung berhenti dengan pesan error yang jelas (fail-fast) —
 * mencegah aplikasi berjalan dalam kondisi konfigurasi tidak lengkap.
 */
export const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  PORT: port({ default: 3000 }),
  DATABASE_URL: str({ desc: 'PostgreSQL connection string' }),
  // Phase 14 (Enterprise Scalability) — connection string PostgreSQL
  // READ REPLICA, opsional. Kalau diisi, query BACA yang secara sadar
  // memakai `prismaRead` (lihat `shared/config/database.ts`) diarahkan
  // ke sini alih-alih ke primary — mengurangi beban baca di primary
  // untuk endpoint listing/laporan bertraffic tinggi. Kalau KOSONG,
  // `prismaRead` otomatis fallback memakai koneksi primary yang sama
  // (`prisma`) — TIDAK ADA perbedaan perilaku untuk deployment yang
  // belum punya replica.
  //
  // PERINGATAN REPLICATION LAG — replica PostgreSQL standar bersifat
  // ASYNCHRONOUS: ada jeda (biasanya milidetik, TAPI bisa lebih lama
  // saat replica sedang tertinggal) antara data ditulis ke primary dan
  // terlihat di replica. `prismaRead` HANYA aman dipakai untuk query
  // yang TIDAK butuh melihat tulisan yang baru saja terjadi di request
  // yang SAMA (mis. "tampilkan SEMUA event publik" aman; "tampilkan
  // event yang BARU SAJA saya buat di halaman konfirmasi berikutnya"
  // TIDAK aman — pakai `prisma` primary untuk kasus itu).
  DATABASE_REPLICA_URL: str({ default: '' }),
  // Connection Pool Optimization (Phase 14) — di-append sebagai query
  // parameter ke `DATABASE_URL`/`DATABASE_REPLICA_URL` (lihat
  // `database.ts`), BUKAN diset lewat konfigurasi terpisah — ini
  // adalah cara resmi Prisma mengatur ukuran connection pool internal
  // (`connection_limit`) dan lama menunggu koneksi kosong sebelum
  // menyerah (`pool_timeout`, detik). `0`/tidak diisi = pakai default
  // Prisma (`num_cpus * 2 + 1`) — SENGAJA tidak dipaksa ke suatu nilai
  // tertentu karena ukuran ideal sangat tergantung jumlah instance API
  // yang berjalan bersamaan (`instances × connection_limit` TIDAK
  // BOLEH melebihi `max_connections` PostgreSQL, lihat
  // docs/scalability-guide.md).
  DATABASE_CONNECTION_LIMIT: num({ default: 0 }),
  DATABASE_POOL_TIMEOUT_SECONDS: num({ default: 0 }),
  // Phase 18 (Enterprise Reliability — Graceful Shutdown) — batas
  // waktu MAKSIMAL menunggu request HTTP yang sedang berjalan selesai
  // sebelum proses API server dipaksa keluar saat menerima
  // SIGTERM/SIGINT. Default 10 detik — cukup untuk mayoritas request
  // normal (bukan long-polling/streaming), sekaligus tidak melebihi
  // grace period umum orchestrator (Kubernetes default
  // `terminationGracePeriodSeconds: 30`, PM2 `kill_timeout`) yang akan
  // mengirim SIGKILL kalau proses belum keluar juga.
  SHUTDOWN_TIMEOUT_MS: num({ default: 10_000 }),
  BCRYPT_SALT_ROUNDS: num({ default: 10 }),
  JWT_SECRET: str({ desc: 'Secret key untuk signing & verifying JWT' }),
  // Secret rotation preparation (Phase 5) — SENGAJA opsional. Diisi
  // HANYA selama masa transisi rotasi: pindahkan nilai `JWT_SECRET`
  // LAMA ke sini, lalu isi `JWT_SECRET` dengan yang BARU. Selama masa
  // transisi itu, token yang diterbitkan SEBELUM rotasi (masih
  // ditandatangani secret lama) tetap valid lewat fallback verifikasi
  // di `jwtHelper.verify()` — tanpa ini, mengganti `JWT_SECRET` berarti
  // SELURUH access/refresh token yang sedang beredar langsung invalid
  // serentak, memaksa semua user logout bersamaan. Setelah token lama
  // wajar habis masa berlakunya (>= `JWT_EXPIRES_IN`), variable ini
  // aman dikosongkan lagi.
  JWT_SECRET_PREVIOUS: str({ default: '' }),
  JWT_EXPIRES_IN: str({ default: '1d', desc: 'Contoh: 1h, 1d, 7d' }),
  // Phase 12 (Enterprise Security) — key untuk `EncryptionService`
  // (AES-256-GCM), dipakai untuk column encryption (mis. MFA secret
  // TOTP di `User.mfaSecret`). HARUS string base64 yang mendekode
  // jadi TEPAT 32 byte (256 bit) — divalidasi eksplisit di bawah,
  // bukan cuma dicek "ada isinya", karena key yang salah panjang
  // akan gagal DI RUNTIME saat enkripsi pertama kali dipanggil
  // (`crypto.createCipheriv` melempar error untuk key yang bukan 32
  // byte), jauh lebih baik gagal-cepat saat startup.
  ENCRYPTION_KEY: str({
    desc: 'Base64, harus mendekode jadi 32 byte. Generate: openssl rand -base64 32',
  }),
  // Secret rotation preparation (Phase 12) — pola IDENTIK dengan
  // `JWT_SECRET_PREVIOUS` di atas: isi HANYA selama masa transisi
  // rotasi (pindahkan `ENCRYPTION_KEY` lama ke sini, ganti
  // `ENCRYPTION_KEY` dengan yang baru). Tanpa ini, mengganti
  // `ENCRYPTION_KEY` berarti SELURUH data terenkripsi yang sudah ada
  // (mis. `User.mfaSecret` semua user yang sudah aktifkan MFA)
  // langsung tidak bisa didekripsi lagi.
  ENCRYPTION_KEY_PREVIOUS: str({ default: '' }),
  AWS_REGION: str({ desc: 'Region bucket S3, mis. ap-southeast-1' }),
  AWS_ACCESS_KEY_ID: str({ desc: 'Access key IAM dengan izin PutObject ke bucket upload' }),
  AWS_SECRET_ACCESS_KEY: str(),
  AWS_S3_BUCKET_NAME: str({ desc: 'Nama bucket S3 tujuan upload' }),
  CORS_ALLOWED_ORIGINS: str({
    desc: 'Daftar origin yang diizinkan CORS, dipisah koma. Contoh: https://app.example.com,https://admin.example.com',
  }),
  // SENTRY_DSN SENGAJA opsional (default string kosong) — beda dari
  // env wajib lain di atas. Observability tidak boleh membuat
  // aplikasi gagal start hanya karena belum dikonfigurasi; Sentry
  // cukup tidak aktif (lihat shared/config/sentry.ts) kalau kosong.
  SENTRY_DSN: str({ default: '' }),
  // Phase 13 (Enterprise Observability) — sama filosofinya seperti
  // `SENTRY_DSN` di atas: distributed tracing OPSIONAL, TIDAK BOLEH
  // membuat aplikasi gagal start hanya karena belum ada collector OTLP
  // terpasang. `OTEL_ENABLED` default `false` — nyala SADAR lewat
  // konfigurasi eksplisit, bukan otomatis begitu dependency-nya
  // terpasang (lihat `shared/observability/tracing.ts`).
  OTEL_ENABLED: bool({ default: false }),
  OTEL_SERVICE_NAME: str({ default: 'backend-foundation' }),
  // Endpoint OTLP/HTTP standar — default mengarah ke Jaeger lokal
  // (lihat `docker-compose.monitoring.yml`, container `jaeger`
  // menerima OTLP di port 4318). Ganti ke collector sungguhan
  // (Tempo/Jaeger/vendor APM) di production lewat env ini.
  OTEL_EXPORTER_OTLP_ENDPOINT: str({ default: 'http://localhost:4318/v1/traces' }),
  // Phase 13 — secret opsional untuk memverifikasi webhook Alertmanager
  // BENAR-BENAR datang dari Alertmanager, bukan pihak lain yang
  // menebak URL endpoint-nya. Kosong = verifikasi dilewati (aman
  // SELAMA endpoint ini memang tidak diekspos ke luar
  // `backend-network`, lihat `docker-compose.monitoring.yml`) — isi
  // di production sebagai lapisan pertahanan tambahan.
  ALERTMANAGER_WEBHOOK_SECRET: str({ default: '' }),
  LOG_LEVEL: str({
    choices: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
    default: 'info',
  }),
  // Kredensial OAuth SENGAJA opsional — kalau kosong, endpoint OAuth
  // yang bersangkutan menolak dengan pesan jelas (lihat OAuthService),
  // bukan membuat seluruh aplikasi gagal start hanya karena satu
  // metode login tambahan belum dikonfigurasi.
  GOOGLE_CLIENT_ID: str({ default: '' }),
  GITHUB_CLIENT_ID: str({ default: '' }),
  GITHUB_CLIENT_SECRET: str({ default: '' }),
  // Fase 2 (Enterprise SSO, OIDC) — `APP_BASE_URL` adalah base URL
  // BACKEND ini sendiri (bukan frontend), dipakai untuk menghitung
  // `redirect_uri` yang dikirim ke IdP saat memulai authorization
  // request (`{APP_BASE_URL}/api/v1/auth/sso/:tenantSlug/callback`).
  // WAJIB persis sama dengan redirect URI yang didaftarkan admin di
  // konsol IdP (Okta/Azure AD/dst) — kalau tidak sama, IdP menolak
  // request-nya sendiri (bagian standar OIDC, bukan validasi milik
  // aplikasi ini). Default kosong SENGAJA — kalau belum diisi,
  // `SsoService` menolak dengan pesan jelas alih-alih menghitung
  // redirect_uri yang salah/kosong.
  APP_BASE_URL: str({ default: '' }),
  // Setelah SSO callback sukses, browser di-redirect ke sini dengan
  // SATU kode tukar sekali-pakai (`?code=...`) — BUKAN access/refresh
  // token langsung di URL (token di query string/URL akan tersimpan
  // di riwayat browser, header Referer, dan log server; kode tukar
  // sekali-pakai yang hanya valid singkat & langsung dihapus setelah
  // dipakai jauh lebih aman). Frontend menukar kode ini lewat
  // `POST /auth/sso/consume`.
  SSO_FRONTEND_CALLBACK_URL: str({ default: '' }),
  // Redis SENGAJA opsional — caching murni optimasi performa, bukan
  // fungsionalitas inti. Kalau kosong/tidak terjangkau, cache
  // otomatis dilewati (langsung baca database), bukan membuat
  // aplikasi gagal start atau request gagal karena Redis down.
  REDIS_URL: str({ default: '' }),
  // Phase 14 (Enterprise Scalability) — daftar node Redis Cluster,
  // dipisah koma, format `host:port` (mis.
  // `redis-1:6379,redis-2:6379,redis-3:6379`). Kalau diisi, cache
  // Redis client (`shared/config/redis.ts`) memakai `Redis.Cluster`
  // ioredis alih-alih koneksi tunggal, DAN `REDIS_URL` di atas
  // diabaikan (dua mode ini eksklusif, bukan digabung) — lihat
  // komentar lengkap di `redis.ts` untuk alasan BullMQ (queue) TIDAK
  // ikut memakai mode cluster ini.
  REDIS_CLUSTER_NODES: str({ default: '' }),
  // Phase 14 — berapa job yang boleh diproses SATU worker process
  // secara paralel. Default 5 dipilih sebagai titik tengah aman untuk
  // job I/O-bound (kirim email lewat SMTP/SES) — cukup tinggi untuk
  // throughput lebih baik dari default BullMQ (1, sekuensial murni),
  // cukup rendah untuk tidak membanjiri provider pihak ketiga dengan
  // request paralel yang berlebihan (lihat juga
  // `EMAIL_QUEUE_RATE_LIMIT_MAX` di bawah untuk lapisan kontrol kedua).
  EMAIL_QUEUE_CONCURRENCY: num({ default: 5 }),
  NOTIFICATION_QUEUE_CONCURRENCY: num({ default: 5 }),
  // Phase 19 — export (generate CSV/XLSX/PDF + upload ke object
  // storage) JAUH lebih berat secara CPU/memori per job dibanding
  // kirim email/notifikasi (query ribuan baris + serialisasi file di
  // memori) — concurrency default SENGAJA lebih RENDAH (2, bukan 5)
  // supaya beberapa export besar berbarengan tidak menghabiskan
  // memori proses worker.
  EXPORT_QUEUE_CONCURRENCY: num({ default: 2 }),
  // Rate limit BullMQ (`Worker` `limiter` option) — berapa job MAKSIMAL
  // yang boleh MULAI diproses dalam `EMAIL_QUEUE_RATE_LIMIT_DURATION_MS`
  // milidetik, LINTAS SEMUA job paralel di worker ini (beda dari
  // `EMAIL_QUEUE_CONCURRENCY` yang membatasi berapa job berjalan
  // BERSAMAAN, bukan berapa yang MULAI per satuan waktu). Default 100
  // job/menit — jauh di bawah rate limit umum provider SMTP/SES,
  // sengaja konservatif karena nilai pastinya sangat tergantung paket
  // provider yang dipakai; naikkan sesuai kontrak provider Anda.
  EMAIL_QUEUE_RATE_LIMIT_MAX: num({ default: 100 }),
  EMAIL_QUEUE_RATE_LIMIT_DURATION_MS: num({ default: 60_000 }),
  // Kredensial Basic Auth untuk dashboard Bull Board (Phase 10
  // upgrade, `GET /admin/queues`) — SENGAJA opsional DAN
  // BERPASANGAN: dashboard hanya dipasang (`app.ts`) kalau KEDUANYA
  // terisi. Beda dari pola "opsional" lain di atas (mis. OAuth, yang
  // aman dibiarkan menyala tapi menolak per-request) — dashboard ini
  // MENGEKSPOS status seluruh job (termasuk payload job yang mungkin
  // berisi data user, mis. `to`/`email` di `EmailJobData`), jadi lebih
  // aman default TIDAK terpasang sama sekali tanpa kredensial eksplisit
  // daripada terpasang dengan proteksi lemah/tertebak.
  QUEUE_DASHBOARD_USER: str({ default: '' }),
  QUEUE_DASHBOARD_PASSWORD: str({ default: '' }),

  // ======================================================================
  // Phase 15 (Enterprise Integration) — abstraction layer provider.
  // Pola SERAGAM di seluruh provider di bawah: `*_PROVIDER` memilih
  // implementasi, default SELALU `log` (mencatat ke Pino, tidak benar-
  // benar memanggil API eksternal apa pun) — persis kelanjutan dari
  // pola `mailer.ts` yang sudah ada sejak sebelum fase ini. Kredensial
  // provider sungguhan SEMUANYA opsional; kalau `*_PROVIDER` diisi ke
  // provider sungguhan TAPI kredensialnya kosong, factory (lihat
  // `shared/integrations/*/index.ts`) fallback ke `log` dengan warning
  // saat startup — SALAH KONFIGURASI TIDAK BOLEH membuat aplikasi
  // gagal start.
  // ======================================================================

  EMAIL_PROVIDER: str({ choices: ['log', 'resend'], default: 'log' }),
  RESEND_API_KEY: str({ default: '' }),
  RESEND_FROM_EMAIL: str({ default: 'onboarding@resend.dev' }),

  SMS_PROVIDER: str({ choices: ['log', 'twilio'], default: 'log' }),
  TWILIO_ACCOUNT_SID: str({ default: '' }),
  TWILIO_AUTH_TOKEN: str({ default: '' }),
  TWILIO_FROM_NUMBER: str({ default: '' }),

  PUSH_PROVIDER: str({ choices: ['log', 'fcm'], default: 'log' }),
  // Server key API lama (legacy) — lihat catatan keterbatasan lengkap
  // di `shared/integrations/push/fcm-push.provider.ts` soal kenapa
  // dipilih dibanding HTTP v1 (butuh OAuth2 service account).
  FCM_SERVER_KEY: str({ default: '' }),

  SEARCH_PROVIDER: str({ choices: ['postgres', 'meilisearch'], default: 'postgres' }),
  MEILISEARCH_HOST: str({ default: 'http://localhost:7700' }),
  MEILISEARCH_API_KEY: str({ default: '' }),

  PAYMENT_PROVIDER: str({ choices: ['log', 'stripe'], default: 'log' }),
  STRIPE_SECRET_KEY: str({ default: '' }),

  OBJECT_STORAGE_PROVIDER: str({ choices: ['s3', 'local'], default: 's3' }),
  // Dipakai HANYA kalau OBJECT_STORAGE_PROVIDER=local — direktori di
  // filesystem container untuk menyimpan file (lihat catatan
  // "TIDAK untuk production" di `local-storage.provider.ts`).
  LOCAL_STORAGE_DIR: str({ default: './uploads-local' }),

  // Webhook Engine (Phase 15) — HMAC secret PER endpoint disimpan di
  // database (`WebhookEndpoint.secret`, dibuat otomatis saat endpoint
  // didaftarkan), bukan satu secret global di sini. Tidak ada env
  // tambahan yang dibutuhkan untuk fitur ini.
});

/**
 * Validasi KEKUATAN `JWT_SECRET` — envalid `str()` di atas hanya
 * memastikan variable-nya ADA dan berupa string, tidak memastikan
 * string itu cukup kuat untuk menandatangani token keamanan. Secret
 * pendek/umum (mis. "secret", "changeme") membuat access token bisa
 * di-forge lewat brute-force offline terhadap algoritma HMAC —
 * kegagalan silent yang jauh lebih berbahaya daripada env var yang
 * hilang sama sekali (yang setidaknya gagal-cepat dan jelas).
 *
 * SENGAJA hanya menghentikan proses (fail-fast, `process.exit(1)`) di
 * `production` — di `development`/`test`, secret pendek yang nyaman
 * untuk setup lokal (termasuk `jest.setup.ts`) TIDAK BOLEH membuat
 * proses gagal start/test gagal jalan; developer cukup diberi
 * peringatan supaya sadar untuk mengganti sebelum deploy sungguhan.
 * `test` bahkan tidak diberi peringatan sama sekali — env test
 * memang selalu memakai secret pendek yang disengaja, dan mencetak
 * peringatan yang sama di SETIAP file test hanya jadi noise.
 */
const MIN_JWT_SECRET_LENGTH = 32;
const KNOWN_WEAK_SECRETS = new Set([
  'secret',
  'changeme',
  'change-me',
  'password',
  '123456',
  'your-secret-key',
  'jwt-secret',
  'jwtsecret',
  'supersecret',
  'secretkey',
  'test-secret-key',
  'admin',
  'qwerty',
]);

function isWeakSecret(secret: string): boolean {
  return secret.length < MIN_JWT_SECRET_LENGTH || KNOWN_WEAK_SECRETS.has(secret.toLowerCase());
}

if (env.NODE_ENV === 'production' && isWeakSecret(env.JWT_SECRET)) {
  // eslint-disable-next-line no-console -- fail-fast startup error, sebelum logger (Pino) sempat terpasang
  console.error(
    `FATAL: JWT_SECRET tidak memenuhi syarat keamanan minimum untuk production ` +
      `(minimal ${MIN_JWT_SECRET_LENGTH} karakter, bukan nilai umum/mudah ditebak). ` +
      `Generate secret baru, mis. lewat: openssl rand -base64 48`
  );
  process.exit(1);
} else if (env.NODE_ENV === 'development' && isWeakSecret(env.JWT_SECRET)) {
  // eslint-disable-next-line no-console -- peringatan startup, sebelum logger (Pino) sempat terpasang
  console.warn(
    `PERINGATAN: JWT_SECRET saat ini lemah (kurang dari ${MIN_JWT_SECRET_LENGTH} karakter atau nilai umum). ` +
      `Ini diizinkan di development, TAPI WAJIB diganti dengan secret yang kuat sebelum deploy ke production.`
  );
}

/**
 * Validasi PANJANG `ENCRYPTION_KEY` (Phase 12) — AES-256-GCM WAJIB
 * key TEPAT 32 byte, bukan "kira-kira panjang". Dicek untuk
 * `ENCRYPTION_KEY` dan `ENCRYPTION_KEY_PREVIOUS` (kalau diisi) di
 * SEMUA environment (bukan cuma production seperti `JWT_SECRET`
 * lemah di atas) — key dengan panjang salah bukan soal "kurang kuat
 * tapi jalan", tapi 100% GAGAL setiap kali dipakai, jadi tidak ada
 * gunanya "izinkan sementara di development".
 */
function assertValidEncryptionKeyLength(value: string, varName: string): void {
  if (!value) return;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) {
    // eslint-disable-next-line no-console -- fail-fast startup error, sebelum logger (Pino) sempat terpasang
    console.error(
      `FATAL: ${varName} harus berupa base64 yang mendekode jadi TEPAT 32 byte (AES-256), ` +
        `saat ini ${decoded.length} byte. Generate: openssl rand -base64 32`
    );
    process.exit(1);
  }
}

assertValidEncryptionKeyLength(env.ENCRYPTION_KEY, 'ENCRYPTION_KEY');
assertValidEncryptionKeyLength(env.ENCRYPTION_KEY_PREVIOUS, 'ENCRYPTION_KEY_PREVIOUS');
