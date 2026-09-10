import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Membungkus controller async agar error yang terjadi otomatis
 * diteruskan ke `next()` — menghindari try/catch berulang di setiap
 * controller method.
 */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
