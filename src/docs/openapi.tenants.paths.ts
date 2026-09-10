import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);
const forbiddenNoManage = errorResponse(
  'Requester tidak punya permission tenant.manage',
  'Anda tidak punya izin untuk aksi ini'
);

const TenantSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string', example: 'acme-corp' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/**
 * Fase Foundation (Phase 11) SENGAJA hanya `list`/`create` — update/
 * suspend status dan penghapusan tenant ditunda ke fase berikutnya
 * (lihat docs/tenant-migration-strategy.md), jadi TIDAK didokumentasikan
 * di sini karena belum ada endpoint-nya sama sekali.
 */
export const tenantsPaths = {
  '/tenants': {
    get: {
      tags: ['Tenants'],
      summary: 'Daftar tenant — butuh permission tenant.manage (admin platform)',
      description:
        'Dipaginasi (P3 Database Audit) — sebelumnya mengembalikan seluruh baris tanpa batas, ' +
        'sekarang konsisten dengan GET /users, /events, /products.',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1, minimum: 1 } },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        },
      ],
      responses: {
        '200': {
          description: 'Daftar tenant ter-paginasi berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daftar tenant berhasil diambil' },
                  data: { type: 'array', items: TenantSchema },
                  meta: { $ref: '#/components/schemas/PaginationMeta' },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNoManage,
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
    post: {
      tags: ['Tenants'],
      summary: 'Buat tenant baru — butuh permission tenant.manage (admin platform)',
      description:
        '`slug` harus unik (huruf kecil, angka, tanda hubung saja) — dipakai sebagai identitas ' +
        'tenant yang terlihat (mis. header `X-Tenant-ID`).',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['slug', 'name'],
              properties: {
                slug: {
                  type: 'string',
                  minLength: 2,
                  maxLength: 63,
                  pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
                  example: 'acme-corp',
                },
                name: { type: 'string', minLength: 1, maxLength: 200 },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Tenant berhasil dibuat',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Tenant berhasil dibuat' },
                  data: TenantSchema,
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNoManage,
        '409': errorResponse(
          'Slug sudah dipakai tenant lain',
          'Tenant dengan slug "acme-corp" sudah terdaftar'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
};
