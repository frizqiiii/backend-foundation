import type { Request, Response, NextFunction } from 'express';
import { sanitizeInput } from './sanitize-input.middleware';

function createMockReq(body: unknown): Request {
  return { body } as Request;
}

describe('sanitizeInput', () => {
  it('menghapus tag <script> dari field string di body', () => {
    const req = createMockReq({ name: '<script>alert(1)</script>Budi' });
    const next = jest.fn() as NextFunction;

    sanitizeInput(req, {} as Response, next);

    expect((req.body as { name: string }).name).toBe('Budi');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('membersihkan string secara REKURSIF di dalam nested object', () => {
    const req = createMockReq({
      profile: { bio: '<img src=x onerror=alert(1)>Halo dunia' },
    });

    sanitizeInput(req, {} as Response, jest.fn());

    expect((req.body as { profile: { bio: string } }).profile.bio).toBe('Halo dunia');
  });

  it('membersihkan string di dalam array', () => {
    const req = createMockReq({ tags: ['<b>tag1</b>', 'tag2<script>x</script>'] });

    sanitizeInput(req, {} as Response, jest.fn());

    expect((req.body as { tags: string[] }).tags).toEqual(['tag1', 'tag2']);
  });

  it('TIDAK mengubah nilai non-string (number, boolean, null)', () => {
    const req = createMockReq({ age: 25, active: true, deletedAt: null });

    sanitizeInput(req, {} as Response, jest.fn());

    expect(req.body).toEqual({ age: 25, active: true, deletedAt: null });
  });

  it('tidak melempar error ketika body kosong/undefined', () => {
    const req = { body: undefined } as unknown as Request;
    const next = jest.fn() as NextFunction;

    expect(() => sanitizeInput(req, {} as Response, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
