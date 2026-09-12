/**
 * Sebelum file ini ada, `http-error.ts` cuma "tersentuh" secara TIDAK
 * LANGSUNG lewat test file lain (service/middleware yang melempar
 * error ini, lalu cuma dicek `instanceof` atau status HTTP akhirnya
 * lewat `errorHandler`) — coverage baris/branch biasa terlihat 100%,
 * tapi TIDAK ADA assertion yang memverifikasi angka status code atau
 * teks pesan default SECARA SPESIFIK. Akibatnya (ditemukan lewat
 * mutation testing, Fase 1 item 1.2): mutation score 0% — mutant yang
 * mengubah `409` jadi angka lain, atau mengubah teks default pesan,
 * lolos begitu saja karena tidak ada yang benar-benar mencocokkan
 * nilai persisnya.
 *
 * Spec ini SENGAJA menguji setiap subclass secara langsung (bukan
 * lewat skenario end-to-end) supaya setiap literal (status code,
 * message default, `name`) punya assertion presisi masing-masing.
 */
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from './http-error';

describe('http-error', () => {
  describe('HttpError (base class)', () => {
    it('menyimpan statusCode dan message persis sesuai argumen konstruktor', () => {
      const error = new HttpError(418, 'Saya teko');

      expect(error.statusCode).toBe(418);
      expect(error.message).toBe('Saya teko');
      expect(error.name).toBe('HttpError');
      expect(error).toBeInstanceOf(Error);
    });

    it('stack trace tetap ada (Error.captureStackTrace tidak menghapusnya)', () => {
      const error = new HttpError(500, 'x');

      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
    });
  });

  describe('ConflictError', () => {
    it('statusCode PERSIS 409 (bukan 400/408/410 atau angka lain)', () => {
      const error = new ConflictError('Data sudah ada');

      expect(error.statusCode).toBe(409);
      expect(error.message).toBe('Data sudah ada');
      expect(error.name).toBe('ConflictError');
      expect(error).toBeInstanceOf(HttpError);
    });
  });

  describe('NotFoundError', () => {
    it('statusCode PERSIS 404', () => {
      const error = new NotFoundError('User tidak ditemukan');

      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('User tidak ditemukan');
      expect(error.name).toBe('NotFoundError');
      expect(error).toBeInstanceOf(HttpError);
    });
  });

  describe('BadRequestError', () => {
    it('statusCode PERSIS 400', () => {
      const error = new BadRequestError('Input tidak valid');

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Input tidak valid');
      expect(error.name).toBe('BadRequestError');
      expect(error).toBeInstanceOf(HttpError);
    });
  });

  describe('UnauthorizedError', () => {
    it('statusCode PERSIS 401 dengan message KUSTOM kalau diberikan', () => {
      const error = new UnauthorizedError('Token kadaluarsa');

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Token kadaluarsa');
      expect(error.name).toBe('UnauthorizedError');
    });

    it('message DEFAULT persis "Unauthorized" kalau argumen tidak diberikan', () => {
      const error = new UnauthorizedError();

      expect(error.message).toBe('Unauthorized');
    });
  });

  describe('ForbiddenError', () => {
    it('statusCode PERSIS 403 dengan message kustom kalau diberikan', () => {
      const error = new ForbiddenError('Bukan admin');

      expect(error.statusCode).toBe(403);
      expect(error.message).toBe('Bukan admin');
      expect(error.name).toBe('ForbiddenError');
    });

    it('message DEFAULT persis teks Bahasa Indonesia aslinya (bukan string kosong/berbeda)', () => {
      const error = new ForbiddenError();

      expect(error.message).toBe('Anda tidak memiliki akses untuk melakukan aksi ini');
    });
  });

  describe('TooManyRequestsError', () => {
    it('statusCode PERSIS 429 dengan message kustom kalau diberikan', () => {
      const error = new TooManyRequestsError('Tunggu 60 detik lagi');

      expect(error.statusCode).toBe(429);
      expect(error.message).toBe('Tunggu 60 detik lagi');
      expect(error.name).toBe('TooManyRequestsError');
    });

    it('message DEFAULT persis teks Bahasa Indonesia aslinya', () => {
      const error = new TooManyRequestsError();

      expect(error.message).toBe('Terlalu banyak permintaan, silakan coba lagi nanti');
    });
  });

  it('setiap subclass punya statusCode BERBEDA satu sama lain (menutup mutant yang menukar angka antar-class)', () => {
    const statusCodes = [
      new ConflictError('x').statusCode,
      new NotFoundError('x').statusCode,
      new BadRequestError('x').statusCode,
      new UnauthorizedError('x').statusCode,
      new ForbiddenError('x').statusCode,
      new TooManyRequestsError('x').statusCode,
    ];

    expect(new Set(statusCodes).size).toBe(statusCodes.length);
    expect(statusCodes).toEqual([409, 404, 400, 401, 403, 429]);
  });
});
