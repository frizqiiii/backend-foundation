import { generateSecureToken, hashSecureToken } from './secure-token';

describe('generateSecureToken', () => {
  it('menghasilkan string base64url non-kosong', () => {
    const token = generateSecureToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('P5 — menghasilkan token BERBEDA setiap dipanggil', () => {
    expect(generateSecureToken()).not.toBe(generateSecureToken());
  });
});

describe('hashSecureToken', () => {
  it('menghasilkan hash SHA-256 hex 64 karakter, konsisten untuk input yang sama', () => {
    const token = generateSecureToken();
    const hash = hashSecureToken(token);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecureToken(token)).toBe(hash);
  });

  it('menghasilkan hash BERBEDA untuk token berbeda', () => {
    expect(hashSecureToken('token-a')).not.toBe(hashSecureToken('token-b'));
  });
});
