import type { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'events';
import { metricsMiddleware } from './metrics.middleware';
import { metricsRegistry, httpRequestsTotal, httpRequestDurationSeconds } from './metrics.registry';

/**
 * `Response` asli di-mock secara minimal lewat `EventEmitter` — yang
 * benar-benar dipakai middleware hanyalah `res.on('finish', ...)` dan
 * `res.statusCode`, jadi tiruan sesederhana ini cukup tanpa perlu
 * `supertest`/server sungguhan. Emit `'finish'` manual mensimulasikan
 * Express yang baru memicu event tersebut setelah response benar-benar
 * selesai dikirim.
 */
function createMockReqRes(overrides: Partial<Request> = {}): {
  req: Request;
  res: Response & EventEmitter;
} {
  const req = { method: 'GET', baseUrl: '', route: undefined, ...overrides } as unknown as Request;
  const res = new EventEmitter() as Response & EventEmitter;
  res.statusCode = 200;
  return { req, res };
}

describe('metricsMiddleware', () => {
  beforeEach(async () => {
    metricsRegistry.resetMetrics();
  });

  it('memanggil next() segera tanpa menunggu response selesai', () => {
    const { req, res } = createMockReqRes();
    const next = jest.fn() as NextFunction;

    metricsMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('mencatat http_requests_total dengan label route pattern (bukan URL mentah) setelah response selesai', async () => {
    const { req, res } = createMockReqRes({
      baseUrl: '/api/v1/events',
      route: { path: '/:id' } as Request['route'],
    });
    res.statusCode = 200;

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metricValue = await httpRequestsTotal.get();
    const matching = metricValue.values.find(
      (v) => v.labels.route === '/api/v1/events/:id' && v.labels.status_code === '200'
    );
    expect(matching?.value).toBe(1);
  });

  it('fallback ke label route "unmatched" ketika tidak ada route yang cocok (404 murni)', async () => {
    const { req, res } = createMockReqRes({ route: undefined });
    res.statusCode = 404;

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metricValue = await httpRequestsTotal.get();
    const matching = metricValue.values.find((v) => v.labels.route === 'unmatched');
    expect(matching?.value).toBe(1);
  });

  it('mencatat durasi request di histogram setelah response selesai', async () => {
    const { req, res } = createMockReqRes({
      baseUrl: '/api/v1/products',
      route: { path: '/' } as Request['route'],
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metricValue = await httpRequestDurationSeconds.get();
    const sampleCount = metricValue.values.find((v) => v.metricName?.endsWith('_count'));
    expect(sampleCount?.value).toBeGreaterThanOrEqual(1);
  });
});
