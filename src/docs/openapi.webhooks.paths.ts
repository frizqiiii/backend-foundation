import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);

/**
 * Ini adalah sistem OUTBOUND webhook-delivery untuk endpoint milik
 * user sendiri (self-service) — beda dari inbound webhook Alertmanager
 * (yang tidak diekspos lewat dokumentasi publik ini). Lihat
 * webhook-signer.ts untuk skema tanda tangan HMAC-SHA256 +
 * timestamp-binding (Finding #22) yang dipakai saat pengiriman.
 */
export const webhooksPaths = {
  '/webhooks': {
    post: {
      tags: ['Webhooks'],
      summary: 'Registrasi endpoint webhook milik sendiri — idempotent (Idempotency-Key)',
      description:
        'URL diperiksa SSRF-guard (menolak target internal/private-network) sebelum disimpan. ' +
        'Response berisi `secret` mentah HANYA SEKALI di sini — dipakai untuk verifikasi HMAC ' +
        'signature tiap delivery, tidak akan ditampilkan lagi setelahnya (tersimpan terenkripsi). ' +
        'Butuh header `Idempotency-Key` (lihat idempotencyMiddleware) — request POST dobel dengan ' +
        'key yang sama TIDAK akan membuat endpoint dobel.',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['url', 'eventTypes'],
              properties: {
                url: { type: 'string', format: 'uri', example: 'https://example.com/hooks' },
                eventTypes: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  example: ['product.created'],
                },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Webhook endpoint berhasil didaftarkan',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: {
                    type: 'string',
                    example:
                      'Webhook endpoint berhasil didaftarkan. SIMPAN secret ini sekarang — tidak akan ditampilkan lagi.',
                  },
                  data: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      url: { type: 'string' },
                      secret: { type: 'string' },
                      eventTypes: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        '400': errorResponse(
          'URL target adalah alamat internal/private-network (ditolak SSRF-guard)',
          'URL tujuan tidak diizinkan'
        ),
        '401': unauthorized,
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
    get: {
      tags: ['Webhooks'],
      summary: 'Daftar webhook endpoint milik sendiri',
      description: 'TIDAK mengembalikan `secret` (hanya dikirim sekali saat registrasi).',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description: 'Daftar webhook endpoint berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daftar webhook endpoint berhasil diambil' },
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        url: { type: 'string' },
                        eventTypes: { type: 'array', items: { type: 'string' } },
                        active: { type: 'boolean' },
                        createdAt: { type: 'string', format: 'date-time' },
                        revokedAt: { type: 'string', format: 'date-time', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '500': serverErrorResponse,
      },
    },
  },
  '/webhooks/{id}': {
    delete: {
      tags: ['Webhooks'],
      summary: 'Cabut webhook endpoint milik sendiri',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Webhook endpoint berhasil dicabut',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Webhook endpoint berhasil dicabut' },
                  data: { type: 'object', nullable: true, example: null },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '404': errorResponse(
          'Webhook endpoint tidak ditemukan atau bukan milik user ini',
          'Webhook endpoint tidak ditemukan'
        ),
        '500': serverErrorResponse,
      },
    },
  },
};
