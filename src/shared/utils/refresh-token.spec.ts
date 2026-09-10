import { generateRefreshToken, hashRefreshToken } from './refresh-token';

describe('generateRefreshToken', () => {
  it('menghasilkan string non-kosong', () => {
    const token = generateRefreshToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('P5 — menghasilkan token BERBEDA setiap dipanggil (acak, bukan konstan)', () => {
    expect(generateRefreshToken()).not.toBe(generateRefreshToken());
  });
});

describe('hashRefreshToken', () => {
  it('menghasilkan hash yang KONSISTEN untuk token yang sama', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it('menghasilkan hash BERBEDA untuk token berbeda', () => {
    expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'));
  });
});
