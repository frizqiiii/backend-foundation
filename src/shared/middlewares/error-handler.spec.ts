import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
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

  describe('error body parser (express.json) — kesalahan client, bukan 500', () => {
    function parserError(type: string, status: number): Error {
      // Bentuk yang sama dengan `http-errors` milik body-parser.
      return Object.assign(new Error(`pesan internal parser untuk ${type}`), {
        type,
        status,
        statusCode: status,
        expose: true,
      });
    }

    it.each([
      ['entity.parse.failed', 400, 'Body request bukan JSON yang valid'],
      ['entity.too.large', 413, 'Ukuran body request melebihi batas maksimal yang diizinkan'],
      ['encoding.unsupported', 415, 'Encoding atau charset body request tidak didukung'],
      ['charset.unsupported', 415, 'Encoding atau charset body request tidak didukung'],
      ['request.aborted', 400, 'Body request tidak lengkap atau dibatalkan'],
      ['request.size.invalid', 400, 'Body request tidak lengkap atau dibatalkan'],
    ])('type %s -> %i dengan pesan tetap (bukan err.message parser)', (type, status, message) => {
      const res = createMockResponse();

      errorHandler(parserError(type, status), req, res, next);

      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.json).toHaveBeenCalledWith({ success: false, message });
    });

    it('pesan diterjemahkan sesuai Accept-Language, status tidak berubah', () => {
      const res = createMockResponse();
      const enReq = {
        method: 'POST',
        originalUrl: '/test',
        headers: { 'accept-language': 'en' },
      } as unknown as Request;

      errorHandler(parserError('entity.too.large', 413), enReq, res, next);

      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'Request body exceeds the maximum allowed size',
      });
    });

    it('error dengan status 4xx tetapi type TIDAK dikenal tetap 500 (tidak diloloskan sebagai salah client)', () => {
      const res = createMockResponse();

      errorHandler(parserError('type.tak.dikenal', 400), req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('type yang kebetulan nama properti bawaan Object ("constructor") tidak dianggap dikenal', () => {
      const res = createMockResponse();

      errorHandler(parserError('constructor', 400), req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('nilai error primitif/null tidak membuat handler melempar (tetap 500)', () => {
      for (const odd of [null, undefined, 'teks', 42]) {
        const res = createMockResponse();

        errorHandler(odd, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
      }
    });

    it('type bukan string tidak dianggap dikenal', () => {
      const res = createMockResponse();

      errorHandler(Object.assign(new Error('x'), { type: 123 }), req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    describe('terintegrasi dengan express.json asli (kontrak `type` body-parser)', () => {
      let server: http.Server;
      let port: number;

      beforeAll(async () => {
        const app = express();
        app.use(express.json({ limit: '1kb' }));
        app.post('/echo', (_req, res) => {
          res.status(200).json({ success: true });
        });
        app.use(errorHandler);
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
      });

      afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });

      function post(
        body: string,
        headers: Record<string, string> = { 'content-type': 'application/json' }
      ): Promise<{ status: number; body: unknown }> {
        return new Promise((resolve, reject) => {
          const request = http.request(
            { host: '127.0.0.1', port, path: '/echo', method: 'POST', headers },
            (response) => {
              let raw = '';
              response.on('data', (chunk: Buffer) => (raw += chunk.toString()));
              response.on('end', () =>
                resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw) })
              );
            }
          );
          request.on('error', reject);
          request.end(body);
        });
      }

      it('JSON rusak -> 400', async () => {
        const result = await post('{bad json');

        expect(result).toEqual({
          status: 400,
          body: { success: false, message: 'Body request bukan JSON yang valid' },
        });
      });

      it('body melebihi limit -> 413', async () => {
        const result = await post(JSON.stringify({ x: 'a'.repeat(2000) }));

        expect(result).toEqual({
          status: 413,
          body: {
            success: false,
            message: 'Ukuran body request melebihi batas maksimal yang diizinkan',
          },
        });
      });

      it('charset tidak didukung -> 415', async () => {
        const result = await post('{}', { 'content-type': 'application/json; charset=koi8-r' });

        expect(result).toEqual({
          status: 415,
          body: {
            success: false,
            message: 'Encoding atau charset body request tidak didukung',
          },
        });
      });

      it('Content-Encoding tidak didukung -> 415', async () => {
        const result = await post('{}', {
          'content-type': 'application/json',
          'content-encoding': 'x-desain-tak-dikenal',
        });

        expect(result).toEqual({
          status: 415,
          body: {
            success: false,
            message: 'Encoding atau charset body request tidak didukung',
          },
        });
      });

      it('body valid tetap lolos (200)', async () => {
        const result = await post('{"x":1}');

        expect(result).toEqual({ status: 200, body: { success: true } });
      });
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
  describe('item 2.13 — i18n pesan error mengikuti Accept-Language', () => {
    function reqWith(acceptLanguage?: string): Request {
      return {
        method: 'GET',
        originalUrl: '/test',
        headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
      } as unknown as Request;
    }

    it('HttpError: default (tanpa header) tetap Indonesia — perilaku lama tidak berubah', () => {
      const res = createMockResponse();

      errorHandler(new NotFoundError('Produk tidak ditemukan'), reqWith(), res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Produk tidak ditemukan' });
    });

    it('HttpError: Accept-Language en -> pesan berbahasa Inggris, status code TIDAK berubah', () => {
      const res = createMockResponse();

      errorHandler(
        new NotFoundError('Produk tidak ditemukan'),
        reqWith('en-US,en;q=0.9'),
        res,
        next
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Product not found' });
    });

    it('HttpError dengan pesan dinamis: nilainya ikut terbawa ke terjemahan', () => {
      const res = createMockResponse();

      errorHandler(
        new TooManyRequestsError('Terlalu banyak percobaan login gagal. Coba lagi dalam 12 menit.'),
        reqWith('en'),
        res,
        next
      );

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'Too many failed login attempts. Try again in 12 minutes.',
      });
    });

    it('HttpError dengan pesan yang tidak ada di katalog: fallback ke teks asli, bukan error', () => {
      const res = createMockResponse();

      errorHandler(new BadRequestError('Pesan yang belum diterjemahkan'), reqWith('en'), res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'Pesan yang belum diterjemahkan',
      });
    });

    it('ZodError: pesan per-field diterjemahkan, struktur `errors` dan `message` tetap', () => {
      const schema = z.object({ email: z.string().email('Format email tidak valid') });
      const result = schema.safeParse({ email: 'bukan-email' });
      const zodError = (result as { success: false; error: ZodError }).error;
      const res = createMockResponse();

      errorHandler(zodError, reqWith('en'), res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'Validation failed',
        errors: { email: ['Invalid email format'] },
      });
    });

    it('MulterError LIMIT_FILE_SIZE: diterjemahkan', () => {
      const res = createMockResponse();

      errorHandler(new MulterError('LIMIT_FILE_SIZE'), reqWith('en'), res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'File size exceeds the maximum allowed limit',
      });
    });

    it('res.locals.locale (dari localeMiddleware) menang atas header mentah', () => {
      const res = createMockResponse();
      (res as unknown as { locals: Record<string, unknown> }).locals = { locale: 'en' };

      errorHandler(new NotFoundError('Produk tidak ditemukan'), reqWith('id'), res, next);

      expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Product not found' });
    });
  });
});
