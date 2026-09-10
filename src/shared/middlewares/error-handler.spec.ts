import type { Request, Response } from 'express';
import type { ZodError } from 'zod';
import { z } from 'zod';
import { MulterError } from 'multer';
import { errorHandler } from './error-handler';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../utils/http-error';

jest.mock('../logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

function createMockRequest(): Request {
  return { method: 'GET', originalUrl: '/test' } as Request;
}

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('errorHandler', () => {
  const req = createMockRequest();
  const next = jest.fn();

  it('membalas 422 dengan field errors untuk ZodError', () => {
    const schema = z.object({ email: z.string().email() });
    const parseResult = schema.safeParse({ email: 'bukan-email' });
    expect(parseResult.success).toBe(false);
    const zodError = (parseResult as { success: false; error: ZodError }).error;

    const res = createMockResponse();
    errorHandler(zodError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Validation failed',
      errors: zodError.flatten().fieldErrors,
    });
  });

  it.each([
    [new BadRequestError('input tidak valid'), 400],
    [new UnauthorizedError(), 401],
    [new ForbiddenError(), 403],
    [new NotFoundError('produk tidak ditemukan'), 404],
    [new ConflictError('slug sudah dipakai'), 409],
    [new TooManyRequestsError(), 429],
  ])('membalas status code HttpError apa adanya (%#): %s -> %i', (error, expectedStatus) => {
    const res = createMockResponse();
    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(expectedStatus);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: error.message });
  });

  it('membalas 400 dengan pesan Indonesia khusus untuk MulterError LIMIT_FILE_SIZE', () => {
    const error = new MulterError('LIMIT_FILE_SIZE');
    const res = createMockResponse();

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Ukuran file melebihi batas maksimal yang diizinkan',
    });
  });

  it('membalas 400 dengan pesan generik (menyertakan err.message asli Multer) untuk kode MulterError lain', () => {
    const error = new MulterError('LIMIT_UNEXPECTED_FILE');
    const res = createMockResponse();

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: expect.stringContaining('Upload gagal:'),
    });
  });

  describe('error tak terduga (bukan ZodError/HttpError/MulterError)', () => {
    it('P5 — di LUAR production, membalas String(err) apa adanya (memudahkan debugging lokal)', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        await jest.isolateModulesAsync(async () => {
          process.env.NODE_ENV = 'development';
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mod = require('./error-handler');
          const res = createMockResponse();
          const error = new Error('koneksi database gagal di host internal-db-01');

          mod.errorHandler(error, req, res, next);

          expect(res.status).toHaveBeenCalledWith(500);
          expect(res.json).toHaveBeenCalledWith({
            success: false,
            message: String(error),
          });
        });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('P5 — DI production, menyamarkan pesan jadi generik (TIDAK membocorkan detail internal ke client)', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalJwtSecret = process.env.JWT_SECRET;
      try {
        await jest.isolateModulesAsync(async () => {
          process.env.NODE_ENV = 'production';
          // JWT_SECRET kuat — supaya require ulang env.ts tidak ikut
          // memicu process.exit(1) gara-gara validasi kekuatan secret
          // (lihat env.spec.ts / pola yang sama di health.controller.spec.ts).
          process.env.JWT_SECRET = 'a'.repeat(48);
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mod = require('./error-handler');
          const res = createMockResponse();
          const error = new Error('koneksi database gagal di host internal-db-01');

          mod.errorHandler(error, req, res, next);

          expect(res.status).toHaveBeenCalledWith(500);
          expect(res.json).toHaveBeenCalledWith({
            success: false,
            message: 'Internal server error',
          });
        });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.JWT_SECRET = originalJwtSecret;
      }
    });
  });
});
