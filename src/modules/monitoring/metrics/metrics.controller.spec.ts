import type { Request, Response } from 'express';
import { getMetrics } from './metrics.controller';
import { metricsRegistry, httpRequestsTotal } from './metrics.registry';

function createMockResponse(): Response {
  const res = {} as Response;
  res.set = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res;
}

describe('getMetrics', () => {
  it('membalas dengan Content-Type Prometheus dan menyertakan metric yang terdaftar', async () => {
    httpRequestsTotal.inc({ method: 'GET', route: '/api/v1/events', status_code: '200' });
    const res = createMockResponse();

    await getMetrics({} as Request, res);

    expect(res.set).toHaveBeenCalledWith('Content-Type', metricsRegistry.contentType);
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('http_requests_total'));
  });
});
