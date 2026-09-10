import type { Request, Response, NextFunction } from 'express';
import { correlationIdMiddleware, CORRELATION_ID_HEADER } from './correlation-id.middleware';
import { getCorrelationId } from './correlation-id';

function createMockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function createMockRes(): Response & { setHeader: jest.Mock } {
  return { setHeader: jest.fn() } as unknown as Response & { setHeader: jest.Mock };
}

describe('correlationIdMiddleware', () => {
  it('MENGHASILKAN correlation ID baru kalau tidak ada header masuk', () => {
    const req = createMockReq();
    const res = createMockRes();
    let observed: string | undefined;
    const next: NextFunction = jest.fn(() => {
      observed = getCorrelationId();
    });

    correlationIdMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(observed).toEqual(expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, observed);
  });

  it('MEMAKAI ULANG correlation ID dari header masuk (bukan membuat yang baru)', () => {
    const req = createMockReq({ [CORRELATION_ID_HEADER]: 'upstream-req-id-123' });
    const res = createMockRes();
    let observed: string | undefined;
    const next: NextFunction = jest.fn(() => {
      observed = getCorrelationId();
    });

    correlationIdMiddleware(req, res, next);

    expect(observed).toBe('upstream-req-id-123');
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'upstream-req-id-123');
  });

  it('context tidak lagi terbaca setelah middleware selesai (di luar next())', () => {
    const req = createMockReq({ [CORRELATION_ID_HEADER]: 'upstream-req-id-123' });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    correlationIdMiddleware(req, res, next);

    expect(getCorrelationId()).toBeUndefined();
  });
});
