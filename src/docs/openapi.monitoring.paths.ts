import { errorResponse, serverErrorResponse } from './openapi.shared';

/**
 * PENTING — perbedaan base path: `/health`, `/ready`, dan `/metrics`
 * SENGAJA dipasang di ROOT app (app.ts), BUKAN di bawah `/api/v1`
 * seperti seluruh endpoint bisnis lain (kontrak infrastruktur/
 * observability tidak perlu versioning). Server global spec ini
 * adalah `/api/v1`, jadi ketiga path itu di-override dengan
 * `servers: [{ url: '/' }]` di level Path Item supaya tetap akurat
 * tanpa mengubah base path seluruh dokumen. `/internal/alertmanager-
 * webhook` SEBALIKNYA tetap di bawah `/api/v1` (lihat app.ts —
 * dipasang lewat `v1Router`), jadi TIDAK butuh override.
 */
const rootServerOverride = [{ url: '/', description: 'Root app (bukan /api/v1) — endpoint infra' }];

export const monitoringPaths = {
  '/health': {
    servers: rootServerOverride,
    get: {
      tags: ['Monitoring'],
      summary: 'Liveness check — publik, tanpa autentikasi',
      description:
        'SENGAJA TIDAK menyentuh dependency eksternal (database/Redis) — kalau liveness ikut ' +
        'bergantung ke dependency yang lambat/down, orchestrator (Kubernetes) bisa salah ' +
        'kesimpulan "proses ini mati" lalu restart proses yang sebenarnya sehat. Selalu 200 ' +
        'selama proses Node masih bisa membalas HTTP sama sekali. Beda dari GET /ready.',
      responses: {
        '200': {
          description: 'Proses hidup',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'ok' },
                  uptime: { type: 'integer', description: 'Detik' },
                  memory: {
                    type: 'object',
                    properties: {
                      rssMb: { type: 'integer' },
                      heapUsedMb: { type: 'integer' },
                      heapTotalMb: { type: 'integer' },
                    },
                  },
                  timestamp: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
  },
  '/ready': {
    servers: rootServerOverride,
    get: {
      tags: ['Monitoring'],
      summary: 'Readiness check — publik, tanpa autentikasi',
      description:
        'Beda dari GET /health: endpoint ini MEMANG menyentuh PostgreSQL/Redis/Queue (dengan ' +
        'timeout 3 detik per dependency). Hanya PostgreSQL yang kegagalannya menjatuhkan status ' +
        'keseluruhan ke 503 — Redis/Queue adalah dependency opsional (aplikasi tetap bisa ' +
        'melayani request inti tanpanya). Selama graceful shutdown (SIGTERM/SIGINT diterima), ' +
        'LANGSUNG membalas 503 tanpa mengecek dependency sama sekali. Pesan error dependency ' +
        'DIREDAKSI jika NODE_ENV=production (Finding #23 — mencegah kebocoran detail internal ' +
        'seperti hostname/port/fragmen kredensial ke siapa pun yang bisa akses endpoint publik ' +
        'ini; detail lengkap tetap ada di server-side log).',
      responses: {
        '200': {
          description: 'Siap menerima traffic (PostgreSQL sehat)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'ready' },
                  checks: {
                    type: 'object',
                    properties: {
                      database: { $ref: '#/components/schemas/DependencyCheckResult' },
                      redis: { $ref: '#/components/schemas/DependencyCheckResult' },
                      queue: { $ref: '#/components/schemas/DependencyCheckResult' },
                    },
                  },
                  timestamp: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        '503': {
          description: 'Tidak siap — PostgreSQL tidak sehat, ATAU proses sedang graceful shutdown',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['not_ready'] },
                  message: { type: 'string', example: 'Proses sedang shutdown' },
                  checks: {
                    type: 'object',
                    nullable: true,
                    description: 'Tidak ada saat status "not_ready" akibat shutdown',
                  },
                  timestamp: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
  },
  '/metrics': {
    servers: rootServerOverride,
    get: {
      tags: ['Monitoring'],
      summary: 'Scrape target Prometheus — publik, tanpa autentikasi',
      description:
        'Format `text/plain` (Content-Type dari prom-client registry), BUKAN amplop JSON ' +
        'standar aplikasi — kontrak ini murni untuk dikonsumsi Prometheus scraper.',
      responses: {
        '200': {
          description: 'Metrik dalam format teks Prometheus',
          content: { 'text/plain': { schema: { type: 'string' } } },
        },
        '500': serverErrorResponse,
      },
    },
  },
  '/internal/alertmanager-webhook': {
    post: {
      tags: ['Monitoring'],
      summary: 'Endpoint internal — menerima notifikasi Alertmanager, menjembatani ke Pino/Sentry',
      description:
        'TIDAK ada Service/Repository di belakang endpoint ini — hanya menjembatani ke logging. ' +
        'Otorisasi opsional lewat header `X-Webhook-Secret` (dibandingkan ke ' +
        '`ALERTMANAGER_WEBHOOK_SECRET`); jika env var itu TIDAK diset, verifikasi DILEWATI ' +
        'sepenuhnya (dimaksudkan untuk jaringan internal Docker yang sudah terpercaya) — catat ' +
        'ini sebagai perhatian konfigurasi produksi, bukan cacat kode. Ditangani secara SINKRON ' +
        '(bukan async), jadi TIDAK dibungkus asyncHandler seperti controller lain.',
      parameters: [
        {
          name: 'X-Webhook-Secret',
          in: 'header',
          required: false,
          description: 'Wajib cocok dengan ALERTMANAGER_WEBHOOK_SECRET jika env var itu diset',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        description: 'Payload webhook Alertmanager (dipangkas ke field yang dipakai)',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['firing', 'resolved'] },
                alerts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['firing', 'resolved'] },
                      labels: { type: 'object', additionalProperties: { type: 'string' } },
                      annotations: { type: 'object', additionalProperties: { type: 'string' } },
                      startsAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Webhook diterima',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Webhook diterima' },
                  data: { type: 'object', nullable: true, example: null },
                },
              },
            },
          },
        },
        '401': errorResponse(
          'Header X-Webhook-Secret tidak cocok dengan ALERTMANAGER_WEBHOOK_SECRET (hanya diperiksa jika env var itu diset)',
          'Webhook secret tidak valid'
        ),
        '500': serverErrorResponse,
      },
    },
  },
};
