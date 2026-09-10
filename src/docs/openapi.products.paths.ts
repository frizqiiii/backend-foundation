import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const unauthorized = errorResponse(
  'Access token tidak ada/tidak valid/kedaluwarsa',
  'Token sudah kadaluarsa'
);

export const productsPaths = {
  '/products': {
    get: {
      tags: ['Products'],
      summary: 'Daftar produk — publik, dengan pagination dan filter',
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1, minimum: 1 } },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        },
        {
          name: 'status',
          in: 'query',
          description: 'Exact match',
          schema: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SOLD'] },
        },
        {
          name: 'category',
          in: 'query',
          description: 'Exact match',
          schema: { type: 'string', enum: ['STANDARD', 'FEATURED', 'PREMIUM'] },
        },
      ],
      responses: {
        '200': {
          description: 'Daftar produk ter-paginasi',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daftar produk berhasil diambil' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/ProductResponse' } },
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
      tags: ['Products'],
      summary: 'Buat produk baru — user manapun yang login',
      description:
        'Produk baru selalu mulai dari category=STANDARD, status=ACTIVE (default skema).',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['title', 'description', 'price'],
              properties: {
                title: { type: 'string', minLength: 3, example: 'Keyboard Mekanik' },
                description: { type: 'string', minLength: 10 },
                price: { type: 'integer', minimum: 0, example: 750000 },
                stock: { type: 'integer', minimum: 0, default: 1, example: 5 },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Produk berhasil dibuat',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Produk berhasil dibuat' },
                  data: { $ref: '#/components/schemas/ProductResponse' },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/products/{id}': {
    delete: {
      tags: ['Products'],
      summary: 'Hapus (soft delete) produk — pemilik produk atau requester dengan product.moderate',
      description:
        'Otorisasi kepemilikan (pemilik ATAU permission `product.moderate`, mis. ADMIN) ' +
        'ditegakkan di ProductService.deleteProduct.',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Produk berhasil dihapus',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Produk berhasil dihapus' },
                  data: { type: 'object', nullable: true, example: null },
                },
              },
            },
          },
        },
        '401': unauthorized,
        '403': errorResponse(
          'Requester bukan pemilik produk dan tidak punya permission product.moderate',
          'Anda hanya bisa menghapus produk milik Anda sendiri'
        ),
        '404': errorResponse('Produk tidak ditemukan', 'Produk tidak ditemukan'),
        '500': serverErrorResponse,
      },
    },
  },
  '/products/{id}/upgrade': {
    patch: {
      tags: ['Products'],
      summary: 'Upgrade kategori produk (STANDARD → FEATURED → PREMIUM)',
      description:
        'Hanya pemilik produk atau ADMIN. Produk harus berstatus ACTIVE dan stok > 0. ' +
        'Kategori tujuan harus lebih tinggi dari kategori saat ini. Perubahan kategori dan ' +
        'pencatatan log audit dilakukan atomik (satu transaksi database).',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['toCategory'],
              properties: {
                toCategory: { type: 'string', enum: ['FEATURED', 'PREMIUM'] },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Produk berhasil di-upgrade',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Produk berhasil di-upgrade' },
                  data: { $ref: '#/components/schemas/ProductResponse' },
                },
              },
            },
          },
        },
        '400': errorResponse(
          'Status bukan ACTIVE, stok habis, atau kategori tujuan bukan tingkatan yang lebih tinggi',
          'Stok produk habis, tidak bisa di-upgrade'
        ),
        '401': unauthorized,
        '403': errorResponse(
          'Requester bukan pemilik produk dan bukan ADMIN',
          'Anda hanya bisa meng-upgrade produk milik Anda sendiri'
        ),
        '404': errorResponse('Produk tidak ditemukan', 'Produk tidak ditemukan'),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
};
