import type { Request } from 'express';
import { getClientIp, getUserAgent } from './request-context';

describe('getClientIp', () => {
  it('mengembalikan req.ip kalau ada', () => {
    const req = { ip: '203.0.113.1' } as Request;
    expect(getClientIp(req)).toBe('203.0.113.1');
  });

  it('mengembalikan null kalau req.ip tidak ada', () => {
    const req = {} as Request;
    expect(getClientIp(req)).toBeNull();
  });
});

describe('getUserAgent', () => {
  it('mengembalikan header user-agent kalau ada', () => {
    const req = { get: jest.fn().mockReturnValue('Mozilla/5.0') } as unknown as Request;
    expect(getUserAgent(req)).toBe('Mozilla/5.0');
  });

  it('mengembalikan null kalau header user-agent tidak dikirim (mis. client non-browser)', () => {
    const req = { get: jest.fn().mockReturnValue(undefined) } as unknown as Request;
    expect(getUserAgent(req)).toBeNull();
  });
});
