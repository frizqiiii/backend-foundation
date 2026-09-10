import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);
const forbiddenNoManage = errorResponse(
  'Requester tidak punya permission user.manage',
  'Anda tidak punya izin untuk aksi ini'
);

/**
 * `POST /register` dan `POST /login` sudah pindah ke modul `auth`
 * (lihat openapi.auth.paths.ts) — modul `users` hanya menyisakan
 * profil (`/me`) dan endpoint admin (`list`/`remove`).
 */
export const usersPaths = {
  '/users/me': {
    get: {
      tags: ['Users'],
      summary: 'Profil akun sendiri',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description: 'Profil berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Profil berhasil diambil' },
                  data: { $ref: '#/components/schemas/UserResponse' },
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
  '/users': {
    get: {
      tags: ['Users'],
      summary: 'Daftar seluruh user — butuh permission user.manage (admin)',
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
          description: 'Daftar user ter-paginasi',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daftar user berhasil diambil' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/UserResponse' } },
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
  },
  '/users/{id}': {
    delete: {
      tags: ['Users'],
      summary: 'Hapus (soft delete) user lain — butuh permission user.manage (admin)',
      description:
        'Tidak ada konsep "user menghapus akunnya sendiri" di endpoint ini — otorisasi murni ' +
        'permission-based di layer routing, tidak ada pengecekan kepemilikan seperti di ' +
        'Events/Products.',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'User berhasil dihapus',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'User berhasil dihapus' },
                  data: { type: 'object', nullable: true, example: null },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNoManage,
        '404': errorResponse('User tidak ditemukan', 'User tidak ditemukan'),
        '500': serverErrorResponse,
      },
    },
  },
};
