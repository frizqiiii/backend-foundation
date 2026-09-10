import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);
const forbiddenNoManage = errorResponse(
  'Requester tidak punya permission feature-flag.manage',
  'Anda tidak punya izin untuk aksi ini'
);

const FeatureFlagSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    key: { type: 'string', example: 'new-checkout-flow' },
    enabled: { type: 'boolean' },
    description: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/**
 * SELURUH endpoint modul ini (baca DAN tulis) di bawah SATU
 * permission `feature-flag.manage` — tidak ada endpoint publik untuk
 * mengecek nilai flag dari luar (resolusi dipakai secara internal).
 */
export const featureFlagsPaths = {
  '/feature-flags': {
    get: {
      tags: ['FeatureFlags'],
      summary: 'Daftar seluruh feature flag — butuh permission feature-flag.manage',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description: 'Daftar feature flag berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daftar feature flag berhasil diambil' },
                  data: { type: 'array', items: FeatureFlagSchema },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNoManage,
        '500': serverErrorResponse,
      },
    },
  },
  '/feature-flags/{key}': {
    put: {
      tags: ['FeatureFlags'],
      summary:
        'Upsert feature flag (buat jika belum ada, update jika sudah) — butuh permission feature-flag.manage',
      description:
        'SENGAJA upsert (bukan POST create + PATCH update terpisah) — operator hanya perlu ' +
        'menyatakan "pastikan flag X bernilai Y" tanpa perlu tahu apakah flag itu sudah ada.',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'key',
          in: 'path',
          required: true,
          schema: { type: 'string' },
          example: 'new-checkout-flow',
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['enabled'],
              properties: {
                enabled: { type: 'boolean' },
                description: { type: 'string', maxLength: 500 },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Feature flag berhasil diperbarui (atau dibuat, jika key belum ada)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Feature flag berhasil diperbarui' },
                  data: FeatureFlagSchema,
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
  },
};
