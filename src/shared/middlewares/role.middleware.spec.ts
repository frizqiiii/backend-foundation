import type { Request, Response, NextFunction } from 'express';
import { requireRole } from './role.middleware';
import { ForbiddenError, UnauthorizedError } from '../utils/http-error';
import type { RoleName } from '../types/role';

function createMockRequest(user?: { id: string; role: RoleName }): Request {
  return { user } as unknown as Request;
}

describe('requireRole', () => {
  const res = {} as Response;
  const next: NextFunction = jest.fn();

  it('melempar UnauthorizedError kalau req.user tidak ada (safety-net — seharusnya authMiddleware sudah menangani lebih dulu)', () => {
    const req = createMockRequest(undefined);
    const middleware = requireRole('ADMIN');

    expect(() => middleware(req, res, next)).toThrow(UnauthorizedError);
  });

  it('melempar ForbiddenError dengan daftar role yang diizinkan kalau role user tidak cocok', () => {
    const req = createMockRequest({ id: 'user-1', role: 'USER' });
    const middleware = requireRole('ADMIN');

    expect(() => middleware(req, res, next)).toThrow(ForbiddenError);
    expect(() => middleware(req, res, next)).toThrow('Aksi ini hanya untuk role: ADMIN');
  });

  it('memanggil next() kalau role user cocok PERSIS dengan satu-satunya role yang diizinkan', () => {
    const req = createMockRequest({ id: 'user-1', role: 'ADMIN' });
    const middleware = requireRole('ADMIN');

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('P5 — mengizinkan OR: role user cocok salah SATU dari beberapa role yang diizinkan', () => {
    const req = createMockRequest({ id: 'user-1', role: 'ORGANIZER' });
    const middleware = requireRole('ADMIN', 'ORGANIZER');

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('P5 — menolak kalau role user TIDAK ada di daftar beberapa role yang diizinkan', () => {
    const req = createMockRequest({ id: 'user-1', role: 'USER' });
    const middleware = requireRole('ADMIN', 'ORGANIZER');

    expect(() => middleware(req, res, next)).toThrow(ForbiddenError);
  });
});
