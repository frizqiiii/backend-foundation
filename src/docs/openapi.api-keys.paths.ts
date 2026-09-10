import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);

/**
 * Self-service sepenuhnya — tidak ada endpoint admin "buat API key
 * untuk user lain" di fase ini.
 */
export const apiKeysPaths = {
  '/api-keys': {
    post: {
      tags: ['ApiKeys'],
      summary: 'Buat API key baru untuk akun sendiri',
      description:
        '`scopes` opsional — array kosong/tidak diisi berarti key mewarisi SELURUH permission ' +
        'role pemiliknya saat ini. Jika diisi, WAJIB subset dari permission role pemiliknya ' +
        '(divalidasi di Service). Response berisi `rawKey` HANYA SEKALI di sini — setelahnya ' +
        'hanya `keyPrefix` yang tersimpan/ditampilkan.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 100, example: 'CI pipeline' },
                scopes: { type: 'array', items: { type: 'string' }, example: ['event.read'] },
                expiresAt: { type: 'string', format: 'date-time', nullable: true },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'API key berhasil dibuat',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: {
                    type: 'string',
                    example:
                      'API key berhasil dibuat. SIMPAN rawKey ini sekarang — tidak akan ditampilkan lagi.',
                  },
                  data: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      name: { type: 'string' },
                      rawKey: { type: 'string' },
                      keyPrefix: { type: 'string' },
                      scopes: { type: 'array', items: { type: 'string' } },
                      expiresAt: { type: 'string', format: 'date-time', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        '400': errorResponse(
          'scopes yang diminta bukan subset dari permission role pemiliknya, atau expiresAt bukan tanggal di masa depan',
          'Scope yang diminta melebihi izin role Anda'
        ),
        '401': unauthorized,
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
    get: {
      tags: ['ApiKeys'],
      summary: 'Daftar API key milik sendiri',
      description: 'TIDAK mengembalikan `rawKey` (hanya dikirim sekali saat pembuatan).',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description: 'Daftar API key berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daftar API key berhasil diambil' },
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        keyPrefix: { type: 'string' },
                        scopes: { type: 'array', items: { type: 'string' } },
                        lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
                        expiresAt: { type: 'string', format: 'date-time', nullable: true },
                        revokedAt: { type: 'string', format: 'date-time', nullable: true },
                        createdAt: { type: 'string', format: 'date-time' },
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
  '/api-keys/{id}': {
    delete: {
      tags: ['ApiKeys'],
      summary: 'Cabut API key milik sendiri',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'API key berhasil dicabut',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'API key berhasil dicabut' },
                  data: { type: 'object', nullable: true, example: null },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '404': errorResponse(
          'API key tidak ditemukan atau bukan milik user ini',
          'API key tidak ditemukan'
        ),
        '500': serverErrorResponse,
      },
    },
  },
};
