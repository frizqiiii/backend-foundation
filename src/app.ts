import type { Application } from 'express';
import crypto from 'node:crypto';
import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import pinoHttp from 'pino-http';
import { authRouter } from './modules/auth/auth.routes';
import { userRouter } from './modules/users/user.routes';
import { productRouter } from './modules/products/product.routes';
import { eventRouter } from './modules/events/event.routes';
import { uploadRouter } from './modules/upload/upload.routes';
import { featureFlagRouter } from './modules/feature-flags/feature-flag.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { healthRouter } from './modules/monitoring/health/health.routes';
import { metricsRouter } from './modules/monitoring/metrics/metrics.routes';
import { metricsMiddleware } from './modules/monitoring/metrics/metrics.middleware';
import { tenantRouter } from './modules/tenants/tenant.routes';
import { apiKeyRouter } from './modules/api-keys/api-key.routes';
import { alertmanagerWebhookRouter } from './modules/monitoring/alerts/alertmanager-webhook.routes';
import { webhookRouter } from './modules/webhooks/webhook.routes';
import { exportRouter } from './modules/exports/export.routes';
import { reportingRouter } from './modules/reporting/reporting.routes';
import { analyticsRouter } from './modules/analytics/analytics.routes';
import { correlationIdMiddleware } from './shared/observability/correlation-id.middleware';
import { getCorrelationId } from './shared/observability/correlation-id';
import { tenantMiddleware } from './shared/tenant/tenant.middleware';
// Side-effect import (Phase 10 upgrade) — mendaftarkan gauge
// `queue_jobs_total`/`queue_worker_up` ke `metricsRegistry` yang sama
// dipakai `metricsRouter` di atas. Diimpor di sini (bukan hanya di
// `worker.ts`) supaya `GET /metrics` di proses API SERVER pun ikut
// melaporkannya — job counts dibaca langsung dari Redis (tidak butuh
// proses worker aktif), lihat `shared/queue/queue.metrics.ts`.
import './shared/queue/queue.metrics';
import { mountQueueDashboard } from './shared/queue/dashboard';
import { mountLocalStorage } from './shared/integrations/storage/local-storage.middleware';
import { errorHandler } from './shared/middlewares/error-handler';
import { sanitizeInput } from './shared/middlewares/sanitize-input.middleware';
import { verifyRequestOrigin } from './shared/middlewares/csrf-protection.middleware';
import { createRateLimiter } from './shared/security/rate-limiter';
import { getRateLimitTier } from './shared/security/rate-limit-tiers';
import { getTenantContext } from './shared/tenant/tenant-context';
import { openApiSpec } from './docs/openapi';
import { env } from './shared/config/env';
import { Sentry } from './shared/config/sentry';
import { logger } from './shared/logger';
import { ForbiddenError, HttpError } from './shared/utils/http-error';

/**
 * Rate limiter khusus `/api/v1/auth/*` — membatasi brute-force pada
 * login/register/refresh. SENGAJA tidak dipasang secara global
 * (endpoint publik seperti `GET /api/v1/events` butuh limit yang jauh
 * lebih longgar, kalau ada, daripada endpoint kredensial). Ini
 * LAPISAN PERTAMA proteksi brute-force (per-IP, mencegah spam request
 * mentah-mentah) — lapisan KEDUA yang lebih presisi (per-email, lihat
 * `shared/security/login-attempt-tracker.ts`) berjalan di dalam
 * `AuthService.login` itu sendiri, karena butuh tahu identitas email
 * yang diserang, bukan cuma IP sumbernya.
 *
 * Phase 6: sekarang dibangun lewat `createRateLimiter` (Redis store
 * ketika `REDIS_URL` dikonfigurasi) — lihat
 * `shared/security/rate-limiter.ts` untuk alasan lengkapnya.
 */
/**
 * `export` (Finding #12, P0/test-isolation) — SEBELUMNYA `const`
 * privat, tidak bisa diakses dari test. `authRateLimiter` (dan
 * `generalRateLimiter` di bawah) memakai `MemoryStore` bawaan
 * `express-rate-limit` ketika Redis tidak dikonfigurasi (lihat
 * `rate-limiter.ts`) — store ini HIDUP SEPANJANG proses/file test
 * berjalan, TIDAK otomatis reset antar `it()`. Test yang sengaja
 * mengirim 11 request ke `/auth/*` untuk memicu 429
 * ("Integration: rate limiting pada /api/auth") meninggalkan counter
 * yang masih tinggi untuk SISA test lain di file yang sama yang
 * menyentuh `/auth/*` (session management, verify-email, logout,
 * dst) — bukan bug di rate limiter itu sendiri (perilaku production
 * MEMANG harus begitu, itu intinya rate limiting), melainkan gap
 * ISOLASI TEST. `export` di sini supaya test bisa memanggil
 * `.resetKey()` (API bawaan express-rate-limit v7) di antara test.
 */
export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 10, // 10 percobaan per IP per window — cukup longgar untuk pengguna sah yang salah ketik, cukup ketat untuk brute-force
  message: 'Terlalu banyak percobaan autentikasi. Coba lagi dalam 15 menit.',
  keyPrefix: 'auth',
});

/**
 * Rate limiter UMUM — dipasang di SELURUH `/api/v1/*`, jauh lebih
 * longgar daripada `authRateLimiter` (endpoint bisnis biasa tidak
 * sesensitif endpoint kredensial). Tujuannya bukan mencegah brute-
 * force spesifik, melainkan proteksi generik terhadap abuse/spam
 * request dalam jumlah sangat besar dari satu sumber (mis. scraper
 * yang tidak terkendali, client yang salah retry tanpa backoff).
 */
const generalRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Terlalu banyak permintaan dari IP ini. Coba lagi dalam beberapa menit.',
  keyPrefix: 'general',
});

/**
 * Rate limiter PER-TENANT (Phase 18 — Enterprise Reliability).
 *
 * BEDA DIMENSI dari `generalRateLimiter` di atas — LAPISAN TAMBAHAN,
 * bukan pengganti. `generalRateLimiter` membatasi per-IP (proteksi
 * abuse dari SATU sumber jaringan); limiter ini membatasi per-TENANT
 * (`tenantId` dari `AsyncLocalStorage`, lihat `tenant-context.ts`) —
 * mencegah SATU tenant (mis. yang API key-nya bocor, atau yang
 * clientnya sedang bug retry tanpa henti) menghabiskan kapasitas
 * server yang sebenarnya dipakai bersama SELURUH tenant lain, tanpa
 * peduli berapa banyak IP/user berbeda yang dipakai tenant tersebut
 * untuk memanggil API (yang tidak akan tertangkap limiter per-IP,
 * karena tersebar di banyak IP).
 *
 * `skip` — kalau TIDAK ADA tenant context aktif (`tenantId: null`,
 * mis. `/auth/register` sebelum user attach ke tenant mana pun, atau
 * endpoint admin lintas-tenant seperti `/tenants`), limiter ini
 * dilewati sepenuhnya — tidak ada tenant untuk dibatasi, dan
 * `generalRateLimiter` per-IP di atas SUDAH cukup untuk endpoint
 * semacam itu.
 *
 * `max: 1000` jauh lebih longgar dari limit per-IP (300) — SATU
 * tenant SAH biasanya dipanggil dari BANYAK IP/user berbeda sekaligus
 * (karyawan, integrasi, dst), jadi kuota gabungannya wajar lebih
 * besar dari kuota satu IP tunggal.
 */
const tenantRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  // Fase 2 (item 2.11) — kuota mengikuti plan tenant aktif (FREE/PRO/
  // ENTERPRISE, lihat `rate-limit-tiers.ts`), dievaluasi per-request.
  // Tier PRO (default, dan fallback kalau plan tidak diketahui) =
  // 1000, angka flat LAMA — perilaku tenant yang sudah ada tidak
  // berubah.
  max: () => getRateLimitTier(getTenantContext().tenantPlan).tenantRequestsPer15Min,
  message: 'Tenant ini telah melebihi kuota permintaan. Coba lagi dalam beberapa menit.',
  keyPrefix: 'tenant',
  keyGenerator: () => getTenantContext().tenantId ?? 'no-tenant',
  skip: () => getTenantContext().tenantId === null,
});

/**
 * Router gabungan untuk v1 — semua modul dipasang di sini, lalu
 * router ini dipasang SEKALI di `/api/v1`. Kalau suatu saat perlu
 * `/api/v2` (mis. breaking change di response shape), cukup buat
 * `v2Router` serupa tanpa mengubah v1 yang sudah dipakai klien lama.
 */
function createV1Router(): Router {
  const v1Router = Router();

  // Rate limiter umum berlaku untuk SELURUH v1 — dipasang di level
  // router ini (bukan diulang manual per-modul) supaya modul baru di
  // masa depan otomatis ikut terlindungi tanpa perlu diingat-ingat.
  v1Router.use(generalRateLimiter);
  // Phase 18 — lapisan per-tenant TAMBAHAN, lihat komentar lengkap di
  // definisi `tenantRateLimiter` di atas.
  v1Router.use(tenantRateLimiter);

  v1Router.use('/auth', authRateLimiter, authRouter);
  v1Router.use('/users', userRouter);
  v1Router.use('/products', productRouter);
  v1Router.use('/events', eventRouter);
  v1Router.use('/upload', uploadRouter);
  v1Router.use('/feature-flags', featureFlagRouter);
  v1Router.use('/dashboard', dashboardRouter);
  // Phase 11 — endpoint admin platform untuk mengelola tenant itu
  // sendiri. TIDAK di-scope ke tenant manapun (masuk akal: mengelola
  // DAFTAR tenant secara definisi adalah operasi lintas-tenant), jadi
  // sengaja tidak butuh header `X-Tenant-ID` sama sekali — otorisasi
  // cukup lewat permission `tenant.manage` (lihat `tenant.routes.ts`).
  v1Router.use('/tenants', tenantRouter);
  // Phase 12 (Enterprise Security) — self-service API key management
  // (`req.user.id`, lihat komentar `ApiKeyController`).
  v1Router.use('/api-keys', apiKeyRouter);
  // Phase 13 — endpoint internal (TIDAK ada di dokumentasi API publik,
  // TIDAK memakai `authMiddleware` — pemanggilnya adalah Alertmanager,
  // bukan user; keamanannya lewat isolasi jaringan Docker +
  // `ALERTMANAGER_WEBHOOK_SECRET` opsional, lihat komentar di
  // `alertmanager-webhook.controller.ts`).
  v1Router.use('/internal/alertmanager-webhook', alertmanagerWebhookRouter);
  // Phase 15 — self-service registrasi webhook endpoint KELUAR (beda
  // arah dari `/internal/alertmanager-webhook` di atas, yang menerima
  // webhook MASUK dari Alertmanager).
  v1Router.use('/webhooks', webhookRouter);
  // Phase 19 (Enterprise Platform) — Export Service.
  v1Router.use('/exports', exportRouter);
  // Phase 20 (Reporting & Analytics Service) — statistik per-domain
  // (`/reporting/*`) dan metrik time-series (`/analytics/*`), lihat
  // komentar lengkap di masing-masing `*.routes.ts`.
  v1Router.use('/reporting', reportingRouter);
  v1Router.use('/analytics', analyticsRouter);

  return v1Router;
}

/**
 * Perakitan aplikasi Express: middleware global, registrasi route
 * per-modul, dan error handler paling akhir.
 *
 * Untuk menambah modul baru: import router-nya dan daftarkan di
 * `createV1Router()` di atas.
 */
export function createApp(): Application {
  const app = express();

  // `trust proxy` — WAJIB di deployment production (lihat
  // `deploy/nginx`, `docker-compose.prod.yml`): tanpa ini, Express
  // membaca `req.ip` sebagai IP Nginx itu sendiri untuk SEMUA request
  // (bukan IP client asli), yang merusak dua hal sekaligus: (1)
  // seluruh rate limiter di atas jadi menghitung SATU IP saja untuk
  // semua orang di belakang proxy — begitu limit tercapai oleh siapa
  // pun, SEMUA client lain ikut diblokir; (2) `AuditLog`/`ActivityLog`
  // (Phase 5) mencatat IP yang salah untuk forensik. `1` berarti
  // percaya SATU hop proxy langsung di depan Node — sesuai topologi
  // Nginx → backend_app yang didokumentasikan di `deploy/nginx`.
  app.set('trust proxy', 1);

  // Helmet HARUS di paling awal — memasang security header (X-Frame-
  // Options, X-Content-Type-Options, Strict-Transport-Security, dst)
  // sebelum middleware/route lain sempat mengirim response apa pun.
  //
  // CSP dikonfigurasi eksplisit (bukan default Helmet yang generik) —
  // `defaultSrc: 'self'` sebagai baseline paling ketat, dengan
  // pengecualian SADAR untuk `/api-docs` (Swagger UI butuh
  // `unsafe-inline` untuk style/script bawaannya sendiri agar bisa
  // tampil — API ini murni JSON, tidak pernah merender HTML dari
  // input pengguna di luar halaman dokumentasi, jadi risiko XSS dari
  // pengecualian ini minimal dan sudah diperhitungkan).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      // HSTS — paksa browser SELALU memakai HTTPS untuk origin ini ke
      // depannya, 180 hari, termasuk subdomain. Tidak berefek apa pun
      // di HTTP biasa (browser hanya menghormati header ini lewat
      // response HTTPS) — aman dipasang tanpa syarat, relevan begitu
      // `deploy/nginx` mengaktifkan TLS di depan aplikasi ini.
      hsts: { maxAge: 180 * 24 * 60 * 60, includeSubDomains: true },
    })
  );

  // Correlation ID (Phase 13) — SEDINI mungkin setelah Helmet (yang
  // memang harus paling pertama, lihat komentar di atas), supaya
  // SELURUH middleware/route sesudahnya — termasuk yang berujung
  // error di CORS/rate-limiter — berjalan di dalam context correlation
  // ID yang sama. `pinoHttp` di bawah dikonfigurasi memakai ID yang
  // sama ini sebagai `req.id`, jadi satu request bisa ditelusuri utuh
  // lewat SATU nilai di seluruh baris log yang dihasilkannya.
  app.use(correlationIdMiddleware);

  // CORS whitelist ketat — HANYA origin yang eksplisit terdaftar di
  // CORS_ALLOWED_ORIGINS yang diizinkan, BUKAN wildcard "*". Request
  // tanpa header Origin (curl, aplikasi mobile, server-ke-server)
  // tetap diizinkan lewat — kebijakan CORS murni ditegakkan browser,
  // tidak relevan untuk klien non-browser.
  //
  // Phase 6 "advanced CORS": `PUT`/`OPTIONS` ditambahkan (preflight
  // butuh `OPTIONS` eksplisit di daftar method yang diizinkan agar
  // browser tidak menolaknya sendiri sebelum sempat sampai ke sini),
  // `maxAge` menyimpan hasil preflight di sisi browser selama 10
  // menit (mengurangi request `OPTIONS` berulang untuk kombinasi
  // origin+method+header yang sama), dan `optionsSuccessStatus: 200`
  // untuk kompatibilitas klien lama yang memperlakukan `204` sebagai
  // error pada preflight.
  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new ForbiddenError(`Origin ${origin} tidak diizinkan oleh kebijakan CORS`));
      },
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      // Finding #16 (P1) — SEBELUMNYA hanya `Content-Type`/`Authorization`.
      // Header custom yang dipakai fitur aplikasi sendiri (tenant
      // middleware Phase 11, correlation-id Phase 13) tidak pernah
      // ditambahkan ke sini saat fitur itu dibuat — akibatnya browser
      // cross-origin (origin yang SUDAH terdaftar di
      // `CORS_ALLOWED_ORIGINS`) tidak bisa mengirim `X-Tenant-ID` sama
      // sekali (ditolak preflight), jadi fitur multi-tenant efektif
      // tidak bisa dipakai dari client SPA cross-origin manapun.
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Correlation-Id'],
      maxAge: 600,
      optionsSuccessStatus: 200,
    })
  );

  app.use(express.json());

  // Sanitasi input — lapisan pertahanan TAMBAHAN (defense in depth) di
  // ATAS validasi Zod per-endpoint, lihat komentar lengkap di
  // `sanitize-input.middleware.ts`. Dipasang SETELAH `express.json()`
  // (butuh `req.body` sudah ter-parse) dan SEBELUM route mana pun.
  app.use(sanitizeInput);

  // Verifikasi Origin untuk request yang mengubah state — padanan
  // CSRF protection yang SUNGGUHAN relevan untuk API Bearer-token ini
  // (bukan cookie-based session). Lihat catatan adaptasi lengkap di
  // `csrf-protection.middleware.ts` untuk alasan kenapa `csurf`
  // klasik TIDAK dipakai di sini.
  app.use(verifyRequestOrigin(allowedOrigins));

  // Tenant Middleware (Phase 11) — dipasang SEDINI mungkin (sebelum
  // logging/metrics/route bisnis apa pun) supaya tenant context sudah
  // aktif untuk SELURUH request berikutnya, termasuk yang berujung
  // error di middleware lain. Lihat catatan lengkap "MODE TRANSISI"
  // di `tenant.middleware.ts` — TIDAK breaking terhadap request tanpa
  // header tenant sama sekali.
  app.use(tenantMiddleware);

  // Log setiap request/response secara otomatis (method, path, status,
  // durasi, request ID) lewat instance Pino yang sama dengan
  // `error-handler.ts` — satu sumber log terstruktur untuk seluruh
  // aplikasi, bukan `console.log` yang tercecer di banyak tempat.
  // Phase 13 — `genReqId` memakai correlation ID yang SAMA yang sudah
  // ditetapkan `correlationIdMiddleware` di atas (dibaca dari
  // AsyncLocalStorage, bukan dibuat ulang) — tanpa ini, pino-http akan
  // menghasilkan `req.id`-nya SENDIRI yang berbeda dari
  // `X-Correlation-ID` yang dikembalikan ke client, membuat keduanya
  // tidak bisa dipakai untuk menautkan log yang sama.
  app.use(pinoHttp({ logger, genReqId: () => getCorrelationId() ?? crypto.randomUUID() }));

  // Instrumentasi metrics dipasang seawal mungkin (setelah logger,
  // sebelum route bisnis) agar SETIAP request tercatat di
  // `http_requests_total`/`http_request_duration_seconds`, termasuk
  // yang berujung error di middleware lain (CORS, rate limit, dst).
  app.use(metricsMiddleware);

  // `/health` dan `/ready` SENGAJA tidak di-versioning — keduanya
  // pemeriksaan infrastruktur (load balancer, orchestrator), bukan
  // resource API bisnis yang perlu evolusi versi. Lihat
  // `modules/monitoring/health` untuk perbedaan liveness vs readiness.
  app.use(healthRouter);

  // `/metrics` — scrape target Prometheus, juga tidak di-versioning
  // dengan alasan yang sama seperti health check di atas.
  app.use('/metrics', metricsRouter);

  // Bull Board — dashboard visual BullMQ (Phase 10 upgrade), juga
  // tidak di-versioning (kontrak operasional, bukan resource bisnis).
  // Fungsi ini SENDIRI yang memutuskan apakah benar-benar dipasang —
  // lihat `shared/queue/dashboard.ts` untuk syaratnya.
  mountQueueDashboard(app);
  mountLocalStorage(app);

  // Dokumentasi interaktif — mencakup modul Auth, Events, Products
  // (lihat src/docs/openapi.ts). Diletakkan sebelum error handler,
  // sama seperti route lain.
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  app.use('/api/v1', createV1Router());

  /**
   * Sentry HARUS dipasang SETELAH semua route, SEBELUM error handler
   * kita sendiri — begitu urutan yang didokumentasikan resminya.
   * `shouldHandleError` MEMBATASI pelaporan HANYA ke error yang
   * benar-benar tak terduga (status >= 500) — `HttpError` yang
   * statusnya di bawah 500 (401/403/404/409/422/dst) adalah alur
   * bisnis normal, BUKAN bug, dan akan membanjiri Sentry dengan noise
   * kalau ikut dilaporkan.
   */
  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError(error) {
      if (error instanceof HttpError) {
        return error.statusCode >= 500;
      }
      return true;
    },
  });

  // Error handler HARUS didaftarkan paling akhir, setelah semua route.
  app.use(errorHandler);

  return app;
}
