import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const notFoundEvent = errorResponse('Event tidak ditemukan', 'Event tidak ditemukan');
const forbiddenNotOwner = errorResponse(
  'Requester bukan pemilik event dan bukan ADMIN',
  'Anda hanya bisa mengubah atau menghapus event milik Anda sendiri'
);
const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);

export const eventsPaths = {
  '/events': {
    get: {
      tags: ['Events'],
      summary: 'Daftar event — publik, dengan pagination, filter, dan search',
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1, minimum: 1 } },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', default: 10, minimum: 1, maximum: 100 },
        },
        {
          name: 'search',
          in: 'query',
          description: 'Cari di judul (case-insensitive)',
          schema: { type: 'string' },
        },
        { name: 'category', in: 'query', description: 'Exact match', schema: { type: 'string' } },
        {
          name: 'location',
          in: 'query',
          description: 'Contains, case-insensitive',
          schema: { type: 'string' },
        },
        { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        '200': {
          description: 'Daftar event ter-paginasi. Catatan: response TIDAK dibungkus `message`.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daftar event berhasil diambil' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/EventResponse' } },
                  meta: { $ref: '#/components/schemas/PaginationMeta' },
                },
              },
            },
          },
        },
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
    post: {
      tags: ['Events'],
      summary: 'Buat event baru — khusus role ORGANIZER atau ADMIN',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['title', 'category', 'location', 'date'],
              properties: {
                title: { type: 'string', minLength: 3, example: 'Konferensi TypeScript 2026' },
                description: { type: 'string', nullable: true },
                category: { type: 'string', example: 'Teknologi' },
                location: { type: 'string', example: 'Jakarta' },
                date: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Event berhasil dibuat',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Event berhasil dibuat' },
                  data: { $ref: '#/components/schemas/EventResponse' },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': errorResponse(
          'Role requester bukan ORGANIZER/ADMIN',
          'Aksi ini hanya untuk role: ORGANIZER, ADMIN'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/events/export': {
    get: {
      tags: ['Events'],
      summary: 'Export daftar event sebagai file CSV/XLSX — butuh permission event.read',
      description:
        'Menerima filter query yang sama dengan GET /events (search/category/location/dateFrom/' +
        'dateTo), MINUS page/limit — export mengambil SEMUA baris yang cocok (dibatasi ' +
        'EXPORT_MAX_ROWS di service, bukan pagination per-halaman). Harus didaftarkan SEBELUM ' +
        '/events/{id} di router (kalau tidak, "/export" akan tertangkap sebagai :id).',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'format',
          in: 'query',
          schema: { type: 'string', enum: ['csv', 'xlsx'], default: 'csv' },
        },
        { name: 'search', in: 'query', schema: { type: 'string' } },
        { name: 'category', in: 'query', schema: { type: 'string' } },
        { name: 'location', in: 'query', schema: { type: 'string' } },
        { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        '200': {
          description: 'File CSV atau XLSX berisi event yang cocok dengan filter',
          content: {
            'text/csv': { schema: { type: 'string', format: 'binary' } },
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
        '401': unauthorized,
        '403': errorResponse(
          'User tidak punya permission event.read',
          'Anda tidak punya izin untuk aksi ini'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/events/{id}': {
    get: {
      tags: ['Events'],
      summary: 'Detail satu event — publik',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Detail event',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Detail event berhasil diambil' },
                  data: { $ref: '#/components/schemas/EventResponse' },
                },
              },
            },
          },
        },
        '404': notFoundEvent,
        '500': serverErrorResponse,
      },
    },
    patch: {
      tags: ['Events'],
      summary: 'Update event — hanya pemilik event atau ADMIN',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        description: 'Semua field opsional (partial update)',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', minLength: 3 },
                description: { type: 'string' },
                category: { type: 'string' },
                location: { type: 'string' },
                date: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Event berhasil diperbarui',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Event berhasil diperbarui' },
                  data: { $ref: '#/components/schemas/EventResponse' },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNotOwner,
        '404': notFoundEvent,
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
    delete: {
      tags: ['Events'],
      summary: 'Hapus event — hanya pemilik event atau ADMIN',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Event berhasil dihapus',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Event berhasil dihapus' },
                  data: { type: 'object', nullable: true, example: null },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNotOwner,
        '404': notFoundEvent,
        '500': serverErrorResponse,
      },
    },
  },
};
