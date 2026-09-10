import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);
const forbiddenNoDashboardRead = errorResponse(
  'Requester tidak punya permission dashboard.read (sama dengan endpoint /dashboard — data lintas-user/agregat, bukan data milik satu user biasa)',
  'Anda tidak punya izin untuk aksi ini'
);

const ExportJobSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: {
      type: 'string',
      enum: [
        'USERS',
        'AUDIT_LOG',
        'DASHBOARD_STATS',
        'USER_STATISTICS',
        'EVENT_STATISTICS',
        'PRODUCT_STATISTICS',
        'SYSTEM_STATISTICS',
        'DAILY_ACTIVE_USERS',
      ],
    },
    format: { type: 'string', enum: ['CSV', 'XLSX', 'PDF'] },
    status: { type: 'string', enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'] },
    fileUrl: { type: 'string', nullable: true },
    errorMessage: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const exportsPaths = {
  '/exports': {
    post: {
      tags: ['Exports'],
      summary:
        'Minta pembuatan file export (async, diproses BullMQ) — butuh permission dashboard.read',
      description:
        'Mengembalikan 202 (job diterima, BELUM selesai) — poll GET /exports/{id} untuk cek ' +
        'status. Butuh header `Idempotency-Key` (idempotencyMiddleware) supaya retry naif dari ' +
        'client tidak membuat job export dobel (query ribuan baris + generate file berulang kali).',
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
              required: ['type', 'format'],
              properties: {
                type: {
                  type: 'string',
                  enum: [
                    'USERS',
                    'AUDIT_LOG',
                    'DASHBOARD_STATS',
                    'USER_STATISTICS',
                    'EVENT_STATISTICS',
                    'PRODUCT_STATISTICS',
                    'SYSTEM_STATISTICS',
                    'DAILY_ACTIVE_USERS',
                  ],
                },
                format: { type: 'string', enum: ['CSV', 'XLSX', 'PDF'] },
              },
            },
          },
        },
      },
      responses: {
        '202': {
          description: 'Permintaan export diterima, job masuk antrian (status QUEUED)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Permintaan export diterima' },
                  data: ExportJobSchema,
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNoDashboardRead,
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/exports/{id}': {
    get: {
      tags: ['Exports'],
      summary: 'Cek status job export',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Status export',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Status export' },
                  data: ExportJobSchema,
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNoDashboardRead,
        '404': errorResponse(
          'Export job tidak ditemukan atau bukan milik user ini',
          'Export tidak ditemukan'
        ),
        '500': serverErrorResponse,
      },
    },
  },
  '/exports/{id}/download': {
    get: {
      tags: ['Exports'],
      summary: 'Unduh file hasil export yang sudah selesai',
      description:
        'Mengembalikan HTTP 302 redirect ke presigned URL object storage — server API TIDAK ' +
        'men-stream file secara langsung (menghindari bandwidth/latensi download besar ' +
        'membebani proses API yang sama).',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '302': { description: 'Redirect ke URL object storage tempat file tersimpan' },
        '401': unauthorized,
        '403': forbiddenNoDashboardRead,
        '404': errorResponse(
          'Export job tidak ditemukan atau bukan milik user ini',
          'Export tidak ditemukan'
        ),
        '409': errorResponse(
          'Export belum selesai diproses (status masih QUEUED/PROCESSING) atau gagal (FAILED)',
          'Export belum siap diunduh (status saat ini: PROCESSING)'
        ),
        '500': serverErrorResponse,
      },
    },
  },
};
