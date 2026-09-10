import type { NextFunction, Request, Response } from 'express';
import { asyncHandler } from './async-handler';

describe('asyncHandler', () => {
  const req = {} as Request;
  const res = {} as Response;

  it('memanggil fn dengan (req, res, next) dan TIDAK memanggil next kalau fn berhasil', async () => {
    const next: NextFunction = jest.fn();
    const fn = jest.fn().mockResolvedValue(undefined);

    await asyncHandler(fn)(req, res, next);

    expect(fn).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('meneruskan error rejection dari fn ke next() (bukan melempar/unhandled rejection)', async () => {
    const next: NextFunction = jest.fn();
    const error = new Error('gagal di controller');
    const fn = jest.fn().mockRejectedValue(error);

    asyncHandler(fn)(req, res, next);

    // `asyncHandler` sendiri tidak mengembalikan Promise yang bisa
    // di-`await` (kontrak `RequestHandler` Express memang synchronous
    // return void) — beri microtask satu putaran supaya `.catch(next)`
    // internal sempat berjalan sebelum diperiksa.
    await new Promise(process.nextTick);

    expect(next).toHaveBeenCalledWith(error);
  });

  it('P5 — controller async yang throw SEBELUM sempat await pun tetap tertangkap (fungsi `async` selalu mengembalikan Promise, throw di dalamnya otomatis jadi rejection)', async () => {
    const next: NextFunction = jest.fn();
    const error = new Error('error tak terduga sebelum await pertama');
    // eslint-disable-next-line @typescript-eslint/require-await -- sengaja: mensimulasikan controller `async` yang throw sebelum baris `await` manapun
    const fn = jest.fn(async () => {
      throw error;
    });

    asyncHandler(fn)(req, res, next);
    await new Promise(process.nextTick);

    expect(next).toHaveBeenCalledWith(error);
  });
});
