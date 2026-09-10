import type { Request, Response, NextFunction } from 'express';
import { verifyRequestOrigin } from './csrf-protection.middleware';
import { ForbiddenError } from '../utils/http-error';

const allowedOrigins = ['https://app.example.com'];

function createMockReq(method: string, origin: string | undefined): Request {
  return {
    method,
    get: (header: string) => (header.toLowerCase() === 'origin' ? origin : undefined),
  } as unknown as Request;
}

describe('verifyRequestOrigin', () => {
  const middleware = verifyRequestOrigin(allowedOrigins);

  it('melewatkan method aman (GET) tanpa mengecek Origin sama sekali', () => {
    const req = createMockReq('GET', 'https://attacker.com');
    const next = jest.fn() as NextFunction;

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('melewatkan request POST tanpa header Origin (klien non-browser: curl/mobile/server-to-server)', () => {
    const req = createMockReq('POST', undefined);
    const next = jest.fn() as NextFunction;

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('melewatkan request POST dengan Origin yang terdaftar di whitelist', () => {
    const req = createMockReq('POST', 'https://app.example.com');
    const next = jest.fn() as NextFunction;

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('menolak request POST dengan Origin di luar whitelist lewat ForbiddenError', () => {
    const req = createMockReq('POST', 'https://attacker.com');
    const next = jest.fn() as NextFunction;

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });

  it('menolak request DELETE dengan Origin di luar whitelist', () => {
    const req = createMockReq('DELETE', 'https://evil.example');
    const next = jest.fn() as NextFunction;

    middleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });
});
