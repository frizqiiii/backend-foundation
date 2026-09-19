import { authPaths } from './openapi.auth.paths';
import { eventsPaths } from './openapi.events.paths';
import { productsPaths } from './openapi.products.paths';
import { usersPaths } from './openapi.users.paths';
import { uploadPaths } from './openapi.upload.paths';
import { webhooksPaths } from './openapi.webhooks.paths';
import { apiKeysPaths } from './openapi.api-keys.paths';
import { tenantsPaths } from './openapi.tenants.paths';
import { exportsPaths } from './openapi.exports.paths';
import { reportingPaths } from './openapi.reporting.paths';
import { analyticsPaths } from './openapi.analytics.paths';
import { dashboardPaths } from './openapi.dashboard.paths';
import { featureFlagsPaths } from './openapi.feature-flags.paths';
import { monitoringPaths } from './openapi.monitoring.paths';

/**
 * Spesifikasi OpenAPI 3.0 — DITULIS MANUAL (bukan auto-generate dari
 * skema Zod), agar dokumentasi ini benar-benar mencerminkan bentuk
 * response ASLI setiap Controller (termasuk perbedaan halus seperti
 * `GET /events` yang me-return `{ data, meta }` langsung tanpa
 * `message`, sementara sebagian besar endpoint lain membungkusnya
 * dengan `{ message, data }`).
 *
 * Cakupan modul yang sudah didokumentasikan (bertambah bertahap):
 * auth, events, products, users, upload, webhooks. Modul lain
 * (api-keys, tenants, exports, reporting, analytics, dashboard,
 * feature-flags, monitoring/health/metrics/alerts) masih dalam
 * proses — lihat catatan audit proyek untuk progres terkini.
 * Kalau menambah endpoint baru di modul yang SUDAH terdokumentasi,
 * perbarui file `openapi.<modul>.paths.ts` yang relevan secara
 * manual — tidak ada mekanisme sinkronisasi otomatis dari kode ke
 * dokumentasi ini.
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Backend Foundation API',
    version: '1.0.0',
    description:
      'Dokumentasi endpoint modul Auth, Events, dan Products. ' +
      'Semua endpoint terproteksi membutuhkan header ' +
      '`Authorization: Bearer <accessToken>` (lihat skema `bearerAuth`). ' +
      'Field `message` pada respons (sukses, error, dan pesan validasi) mengikuti header ' +
      '`Accept-Language`: `id` (default) atau `en`; bahasa yang dipakai dikembalikan di header ' +
      '`Content-Language`. Lihat docs/i18n.md.',
  },
  servers: [{ url: '/api/v1', description: 'Base path seluruh endpoint (versi 1)' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token hasil `/auth/login` atau `/auth/refresh`.',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string' },
        },
        required: ['success', 'message'],
      },
      ValidationErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Validation failed' },
          errors: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      UserResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AuthTokenPair: {
        type: 'object',
        properties: {
          accessToken: { type: 'string', description: 'JWT umur pendek (lihat JWT_EXPIRES_IN)' },
          refreshToken: {
            type: 'string',
            description: 'String acak umur panjang (7 hari), sekali pakai (rotasi)',
          },
        },
      },
      AuthResponse: {
        allOf: [
          { $ref: '#/components/schemas/AuthTokenPair' },
          {
            type: 'object',
            properties: { user: { $ref: '#/components/schemas/UserResponse' } },
          },
        ],
      },
      EventResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          category: { type: 'string', example: 'Musik' },
          location: { type: 'string', example: 'Jakarta' },
          date: { type: 'string', format: 'date-time' },
          ownerId: { type: 'string', format: 'uuid' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      PaginationMeta: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 10 },
          total: { type: 'integer', example: 42 },
          totalPages: { type: 'integer', example: 5 },
        },
      },
      ProductResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          description: { type: 'string' },
          price: { type: 'integer', example: 750000 },
          category: { type: 'string', enum: ['STANDARD', 'FEATURED', 'PREMIUM'] },
          status: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SOLD'] },
          stock: { type: 'integer', example: 5 },
          userId: { type: 'string', format: 'uuid' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      DependencyCheckResult: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'error', 'not_configured'] },
          latencyMs: { type: 'integer' },
          message: {
            type: 'string',
            description:
              'Hanya ada jika status=error. Diredaksi jadi "Dependency tidak sehat" saat NODE_ENV=production (Finding #23).',
          },
        },
      },
    },
  },
  paths: {
    ...authPaths,
    ...eventsPaths,
    ...productsPaths,
    ...usersPaths,
    ...uploadPaths,
    ...webhooksPaths,
    ...apiKeysPaths,
    ...tenantsPaths,
    ...exportsPaths,
    ...reportingPaths,
    ...analyticsPaths,
    ...dashboardPaths,
    ...featureFlagsPaths,
    ...monitoringPaths,
  },
};
