/**
 * Helper response bersama untuk dokumen OpenAPI — file ini SENGAJA
 * berdiri sendiri tanpa dependensi ke `openapi.ts` maupun file
 * `*.paths.ts` manapun. `openapi.ts` mengimpor path modules, dan path
 * modules butuh helper ini — kalau helper ini ditaruh di `openapi.ts`
 * sendiri, akan tercipta circular import (openapi.ts → paths →
 * openapi.ts) yang di CommonJS bisa membuat salah satu sisi menerima
 * modul yang belum selesai dievaluasi (`undefined`).
 */
export const errorResponse = (description: string, example: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorResponse' },
      example: { success: false, message: example },
    },
  },
});

export const validationErrorResponse = {
  description: 'Validasi input gagal (Zod)',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ValidationErrorResponse' },
      example: {
        success: false,
        message: 'Validation failed',
        errors: { email: ['Format email tidak valid'] },
      },
    },
  },
};

export const serverErrorResponse = errorResponse(
  'Kesalahan internal server — pesan detail disembunyikan di production',
  'Internal server error'
);
