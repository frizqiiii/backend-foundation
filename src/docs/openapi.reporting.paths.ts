import { errorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);
const forbiddenNoDashboardRead = errorResponse(
  'Requester tidak punya permission dashboard.read (kelas kapabilitas yang sama dengan /dashboard/*, bukan permission baru)',
  'Anda tidak punya izin untuk aksi ini'
);

function reportPath(summary: string, successMessage: string, dataSchema: Record<string, unknown>) {
  return {
    get: {
      tags: ['Reporting'],
      summary,
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description: successMessage,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: successMessage },
                  data: dataSchema,
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
  };
}

export const reportingPaths = {
  '/reporting/users': reportPath('Statistik agregat user', 'Statistik user berhasil diambil', {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      byRole: {
        type: 'object',
        additionalProperties: { type: 'integer' },
        example: { ADMIN: 2, USER: 48 },
      },
      signupsLast30Days: { type: 'integer' },
    },
  }),
  '/reporting/events': reportPath('Statistik agregat event', 'Statistik event berhasil diambil', {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      byCategory: { type: 'object', additionalProperties: { type: 'integer' } },
      upcoming: { type: 'integer' },
      past: { type: 'integer' },
    },
  }),
  '/reporting/products': reportPath(
    'Statistik agregat produk',
    'Statistik produk berhasil diambil',
    {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
        byCategory: { type: 'object', additionalProperties: { type: 'integer' } },
      },
    }
  ),
  '/reporting/system': reportPath('Statistik agregat sistem', 'Statistik sistem berhasil diambil', {
    type: 'object',
    properties: {
      totalUploads: { type: 'integer' },
      auditLogByAction: { type: 'object', additionalProperties: { type: 'integer' } },
      dailyActiveUsersLast30Days: {
        type: 'array',
        items: {
          type: 'object',
          properties: { date: { type: 'string', format: 'date' }, count: { type: 'integer' } },
        },
      },
    },
  }),
};
