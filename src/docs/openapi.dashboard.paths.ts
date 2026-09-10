import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);
const forbiddenNoDashboardRead = errorResponse(
  'Requester tidak punya permission dashboard.read',
  'Anda tidak punya izin untuk aksi ini'
);

export const dashboardPaths = {
  '/dashboard/stats': {
    get: {
      tags: ['Dashboard'],
      summary:
        'Ringkasan statistik utama (users/events/products/uploads) — butuh permission dashboard.read',
      description:
        'Ke-6 query hitung dijalankan paralel (Promise.all) — semuanya independen satu sama lain.',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description: 'Statistik dashboard berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Statistik dashboard berhasil diambil' },
                  data: {
                    type: 'object',
                    properties: {
                      totals: {
                        type: 'object',
                        properties: {
                          users: { type: 'integer' },
                          events: { type: 'integer' },
                          products: { type: 'integer' },
                          uploads: { type: 'integer' },
                        },
                      },
                      usersByRole: { type: 'object', additionalProperties: { type: 'integer' } },
                      eventsByCategory: {
                        type: 'object',
                        additionalProperties: { type: 'integer' },
                      },
                      signupsLast30Days: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNoDashboardRead,
        '500': serverErrorResponse,
      },
    },
  },
  '/dashboard/audit-summary': {
    get: {
      tags: ['Dashboard'],
      summary: 'Ringkasan audit log per action — butuh permission dashboard.read',
      description:
        '`from`/`to` HARUS diisi bersamaan atau dikosongkan berdua — rentang tanggal parsial ' +
        'ditolak (422) karena ambigu (mis. `from` tanpa `to` bisa berarti "sampai sekarang" ' +
        'ATAU permintaan tidak lengkap).',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        '200': {
          description: 'Ringkasan audit log berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Ringkasan audit log berhasil diambil' },
                  data: {
                    type: 'object',
                    properties: {
                      byAction: { type: 'object', additionalProperties: { type: 'integer' } },
                      totalEntries: { type: 'integer' },
                    },
                  },
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
};
