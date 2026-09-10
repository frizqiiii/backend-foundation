import type { Request, Response, NextFunction } from 'express';
import { requirePermission } from './permission.middleware';
import { ForbiddenError, UnauthorizedError } from '../utils/http-error';
import type { RoleName } from '../types/role';

function createMockReq(role?: RoleName): Request {
  return (
    role ? { user: { id: 'user-1', email: 'x@x.com', role, jti: 'a', exp: 0 } } : {}
  ) as Request;
}

describe('requirePermission', () => {
  it('melempar UnauthorizedError ketika req.user tidak ada (authMiddleware belum jalan)', () => {
    const middleware = requirePermission('event.create');
    const req = createMockReq();

    expect(() => middleware(req, {} as Response, jest.fn())).toThrow(UnauthorizedError);
  });

  it('memanggil next() ketika role punya permission yang dibutuhkan', () => {
    const middleware = requirePermission('user.manage');
    const req = createMockReq('ADMIN');
    const next = jest.fn() as NextFunction;

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('melempar ForbiddenError ketika role TIDAK punya permission yang dibutuhkan', () => {
    const middleware = requirePermission('user.manage');
    const req = createMockReq('USER');

    expect(() => middleware(req, {} as Response, jest.fn())).toThrow(ForbiddenError);
  });
});
