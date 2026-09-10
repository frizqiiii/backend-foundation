import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);
const forbiddenNoDashboardRead = errorResponse(
  'Requester tidak punya permission dashboard.read (kelas kapabilitas yang sama dengan /dashboard/*, bukan permission baru)',
  'Anda tidak punya izin untuk aksi ini'
);

export const analyticsPaths = {
  '/analytics/daily-active-users': {
    get: {
      tags: ['Analytics'],
      summary: 'Tren daily active users — butuh permission dashboard.read',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'days',
          in: 'query',
          description: 'Rentang hari ke belakang (default ditentukan Service jika tidak diisi)',
          schema: { type: 'integer', minimum: 1, maximum: 90 },
        },
      ],
      responses: {
        '200': {
          description: 'Daily active users berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daily active users berhasil diambil' },
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        date: { type: 'string', format: 'date' },
                        count: { type: 'integer' },
                      },
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
