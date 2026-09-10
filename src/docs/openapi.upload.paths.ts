import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);
const forbiddenNotOwner = errorResponse(
  'Requester bukan pemilik file dan bukan bukan requester dengan permission upload.moderate',
  'Anda hanya bisa mengakses atau menghapus file milik Anda sendiri'
);
const notFoundFile = errorResponse('File tidak ditemukan', 'File tidak ditemukan');

export const uploadPaths = {
  '/upload': {
    post: {
      tags: ['Upload'],
      summary: 'Upload satu file — butuh permission upload.create',
      description:
        'Multipart/form-data, field `file`. Dibatasi 5MB, hanya menerima ' +
        'image/jpeg, image/png, image/webp, image/gif, application/pdf (dicek dua lapis: ' +
        'Content-Type multer allowlist DAN magic-byte pada isi file sesungguhnya — Finding #18, ' +
        'mencegah upload berbahaya dengan Content-Type palsu). Nama file asli TIDAK dipakai ' +
        'langsung sebagai storage key (mencegah path traversal); hanya ekstensinya yang dipakai.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'File berhasil diupload',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'File berhasil diupload' },
                  data: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      url: { type: 'string' },
                      key: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        '400': errorResponse(
          'Tidak ada file di field "file", tipe file tidak diizinkan (allowlist Content-Type), atau isi file tidak cocok dengan Content-Type yang diklaim (magic-byte mismatch)',
          'Isi file tidak cocok dengan tipe yang diklaim (image/png)'
        ),
        '401': unauthorized,
        '403': errorResponse(
          'Requester tidak punya permission upload.create',
          'Anda tidak punya izin untuk aksi ini'
        ),
        '413': errorResponse('Ukuran file melebihi 5MB', 'File terlalu besar'),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/upload/{id}': {
    get: {
      tags: ['Upload'],
      summary: 'Metadata satu file — pemilik file atau requester dengan upload.moderate',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Metadata file berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Metadata file berhasil diambil' },
                  data: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      url: { type: 'string' },
                      originalName: { type: 'string' },
                      mimetype: { type: 'string' },
                      sizeBytes: { type: 'integer' },
                      userId: { type: 'string', format: 'uuid' },
                      createdAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNotOwner,
        '404': notFoundFile,
        '500': serverErrorResponse,
      },
    },
    delete: {
      tags: ['Upload'],
      summary: 'Hapus file — pemilik file atau requester dengan upload.moderate',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'File berhasil dihapus',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'File berhasil dihapus' },
                  data: { type: 'object', nullable: true, example: null },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': forbiddenNotOwner,
        '404': notFoundFile,
        '500': serverErrorResponse,
      },
    },
  },
};
