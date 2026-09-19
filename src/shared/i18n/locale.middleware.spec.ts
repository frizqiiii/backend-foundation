import type { NextFunction, Request, Response } from 'express';
import { localeMiddleware } from './locale.middleware';

function run(acceptLanguage?: string): { res: Response; next: jest.Mock } {
  const req = { headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {} } as Request;
  const res = {
    locals: {},
    setHeader: jest.fn(),
    vary: jest.fn(),
  } as unknown as Response;
  const next = jest.fn();
  localeMiddleware(req, res, next as NextFunction);
  return { res, next };
}

describe('localeMiddleware (item 2.13)', () => {
  it('mengisi res.locals.locale, Content-Language, dan Vary: Accept-Language, lalu next()', () => {
    const { res, next } = run('en-US,en;q=0.9');

    expect(res.locals.locale).toBe('en');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Language', 'en');
    expect(res.vary).toHaveBeenCalledWith('Accept-Language');
    expect(next).toHaveBeenCalledWith();
  });

  it('tanpa header -> id (default), header tetap dipasang', () => {
    const { res, next } = run(undefined);

    expect(res.locals.locale).toBe('id');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Language', 'id');
    expect(res.vary).toHaveBeenCalledWith('Accept-Language');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
