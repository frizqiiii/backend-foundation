import type { Request } from 'express';
import { API_KEY_JTI_PREFIX, isApiKeyAuthenticated } from './api-key-auth';

function reqWithUser(user: Partial<NonNullable<Request['user']>> | undefined): Request {
  return { user } as unknown as Request;
}

describe('isApiKeyAuthenticated (temuan T1)', () => {
  it('true kalau jti berawalan `api-key:` (diisi authMiddleware setelah key valid & lolos kuota per-key)', () => {
    expect(isApiKeyAuthenticated(reqWithUser({ jti: `${API_KEY_JTI_PREFIX}key-1` }))).toBe(true);
  });

  it('false untuk JWT biasa (jti UUID)', () => {
    expect(
      isApiKeyAuthenticated(reqWithUser({ jti: '3f2b8c1e-9d4a-4e7b-8a10-0c5d6e7f8a9b' }))
    ).toBe(false);
  });

  it('false kalau request belum/tidak terautentikasi (req.user kosong) — INI yang membuat header `Bearer bfk_...` di endpoint publik tidak memberi pembebasan', () => {
    expect(isApiKeyAuthenticated(reqWithUser(undefined))).toBe(false);
  });

  it('false kalau jti tidak ada atau bukan string', () => {
    expect(isApiKeyAuthenticated(reqWithUser({}))).toBe(false);
    expect(isApiKeyAuthenticated(reqWithUser({ jti: 42 as never }))).toBe(false);
  });

  it('prefix persis `api-key:` (case-sensitive) — tidak menerima variasi', () => {
    expect(API_KEY_JTI_PREFIX).toBe('api-key:');
    expect(isApiKeyAuthenticated(reqWithUser({ jti: 'API-KEY:key-1' }))).toBe(false);
    expect(isApiKeyAuthenticated(reqWithUser({ jti: 'xapi-key:key-1' }))).toBe(false);
  });
});
