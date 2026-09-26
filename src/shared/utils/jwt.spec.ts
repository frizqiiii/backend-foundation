import jwt from 'jsonwebtoken';

/**
 * Sama seperti `env.spec.ts` — `jwtHelper.verify()` bergantung pada
 * `env.JWT_SECRET_PREVIOUS` yang dibaca EAGER saat modul `env.ts`
 * di-import, jadi skenario rotasi (`JWT_SECRET_PREVIOUS` terisi) HARUS
 * di-`require` ulang lewat `jest.resetModules()`, bukan `import`
 * statis biasa di puncak file (yang hanya mengevaluasi env SEKALI,
 * dari `jest.setup.ts`).
 */
describe('jwtHelper', () => {
  const originalPreviousSecret = process.env.JWT_SECRET_PREVIOUS;

  afterEach(() => {
    process.env.JWT_SECRET_PREVIOUS = originalPreviousSecret;
    jest.resetModules();
  });

  const payload = { id: 'user-1', email: 'budi@example.com', role: 'USER' as const };

  it('sign() menghasilkan token yang bisa diverifikasi ulang oleh verify(), dengan jti & exp terisi', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- konsisten dengan afterEach yang me-reset module
    const { jwtHelper } = require('./jwt');
    const token = jwtHelper.sign(payload);
    const decoded = jwtHelper.verify(token);

    expect(decoded.id).toBe(payload.id);
    expect(decoded.email).toBe(payload.email);
    expect(decoded.role).toBe(payload.role);
    expect(typeof decoded.jti).toBe('string');
    expect(typeof decoded.exp).toBe('number');
  });

  it('verify() melempar error untuk token yang ditandatangani dengan secret yang SAMA SEKALI berbeda (bukan rotasi)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { jwtHelper } = require('./jwt');
    const tokenFromAttacker = jwt.sign(payload, 'secret-acak-tidak-dikenal');

    expect(() => jwtHelper.verify(tokenFromAttacker)).toThrow();
  });

  it('Secret rotation (Phase 5): token LAMA (ditandatangani JWT_SECRET_PREVIOUS) tetap valid selama masa transisi', () => {
    const oldSecret = 'secret-lama-sebelum-rotasi-yang-cukup-panjang';
    process.env.JWT_SECRET_PREVIOUS = oldSecret;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { jwtHelper } = require('./jwt');

    // Token ini SENGAJA ditandatangani manual dengan `oldSecret` —
    // mensimulasikan token yang diterbitkan SEBELUM rotasi terjadi.
    const tokenSignedWithOldSecret = jwt.sign(payload, oldSecret, {
      expiresIn: '1h',
      jwtid: 'old-jti',
    });

    const decoded = jwtHelper.verify(tokenSignedWithOldSecret);
    expect(decoded.id).toBe(payload.id);
  });

  it('sign() SELALU memakai secret AKTIF (JWT_SECRET), TIDAK PERNAH JWT_SECRET_PREVIOUS', () => {
    process.env.JWT_SECRET_PREVIOUS = 'secret-lama-sebelum-rotasi-yang-cukup-panjang';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { jwtHelper } = require('./jwt');

    const token = jwtHelper.sign(payload);

    // Token baru TIDAK BOLEH bisa diverifikasi hanya dengan secret
    // lama — membuktikan `sign()` tidak pernah memakainya.
    expect(() => jwt.verify(token, 'secret-lama-sebelum-rotasi-yang-cukup-panjang')).toThrow();
  });

  it('verify() TETAP melempar error kalau token tidak valid untuk KEDUA secret (aktif maupun lama)', () => {
    process.env.JWT_SECRET_PREVIOUS = 'secret-lama-sebelum-rotasi-yang-cukup-panjang';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { jwtHelper } = require('./jwt');
    const tokenFromAttacker = jwt.sign(payload, 'secret-lain-yang-tidak-dikenal-siapa-siapa');

    expect(() => jwtHelper.verify(tokenFromAttacker)).toThrow();
  });
});

describe('jwtHelper — MFA challenge token', () => {
  afterEach(() => {
    delete process.env.JWT_SECRET_PREVIOUS;
    jest.resetModules();
  });

  it('signMfaChallenge() menghasilkan token yang bisa diverifikasi ulang oleh verifyMfaChallenge(), dengan userId dan type yang benar', () => {
    const { jwtHelper } = require('./jwt');
    const token = jwtHelper.signMfaChallenge('user-1');

    const decoded = jwtHelper.verifyMfaChallenge(token);

    expect(decoded).toMatchObject({ type: 'mfa_challenge', userId: 'user-1' });
  });

  it('T-mutation (id=355) — signMfaChallenge() MEMBAWA klaim exp yang pendek (~5 menit), TIDAK PERNAH tanpa kedaluwarsa sama sekali', () => {
    const { jwtHelper } = require('./jwt');
    const token = jwtHelper.signMfaChallenge('user-1');

    // decode (bukan verify) — cukup untuk membaca klaim, tidak perlu
    // secret. Kalau `expiresIn` hilang dari options (mutan `{}`),
    // token TIDAK AKAN punya klaim `exp` sama sekali (token MFA yang
    // tidak pernah kedaluwarsa — persis yang komentar kodenya sendiri
    // bilang "SENGAJA pendek, cukup untuk buka authenticator app").
    const decoded = jwt.decode(token) as { exp?: number };

    expect(typeof decoded.exp).toBe('number');
    const secondsFromNow = decoded.exp! - Math.floor(Date.now() / 1000);
    expect(secondsFromNow).toBeGreaterThan(0);
    expect(secondsFromNow).toBeLessThanOrEqual(5 * 60);
  });

  it('P5 — verifyMfaChallenge() menolak access token BIASA (type bukan mfa_challenge), walau signature-nya valid', () => {
    const { jwtHelper } = require('./jwt');
    const regularAccessToken = jwtHelper.sign({
      id: 'user-1',
      email: 'budi@example.com',
      role: 'USER',
    });

    expect(() => jwtHelper.verifyMfaChallenge(regularAccessToken)).toThrow(
      'Token bukan token MFA challenge yang valid'
    );
  });

  it('P5 — verifyMfaChallenge() melempar error untuk token yang ditandatangani dengan secret tidak dikenal', () => {
    const { jwtHelper } = require('./jwt');
    const forgedToken = jwt.sign({ type: 'mfa_challenge', userId: 'user-1' }, 'secret-acak');

    expect(() => jwtHelper.verifyMfaChallenge(forgedToken)).toThrow();
  });

  it('P5 — verify() (access token) melempar error langsung kalau JWT_SECRET_PREVIOUS TIDAK diisi (jalur paling umum, tanpa fallback rotasi)', () => {
    delete process.env.JWT_SECRET_PREVIOUS;
    jest.resetModules();
    const { jwtHelper } = require('./jwt');
    const tokenFromAttacker = jwt.sign(
      { id: 'user-1', email: 'budi@example.com', role: 'USER' },
      'secret-benar-benar-tidak-dikenal'
    );

    expect(() => jwtHelper.verify(tokenFromAttacker)).toThrow();
  });

  it('T-mutation (id=339) — MENOLAK token yang ditandatangani dengan secret yang SAMA tapi algoritma BERBEDA (HS384, bukan HS256) — membuktikan JWT_VERIFY_OPTIONS benar-benar membatasi algorithms, bukan objek kosong', () => {
    delete process.env.JWT_SECRET_PREVIOUS;
    jest.resetModules();
    const { jwtHelper } = require('./jwt');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env');
    // Secret-nya PERSIS SAMA (bukan secret asing) — signature HMAC-nya
    // valid secara matematis untuk secret ini. SATU-SATUNYA alasan ini
    // harus ditolak adalah pembatasan `algorithms: ['HS256']` di
    // JWT_VERIFY_OPTIONS. Kalau opsi itu jadi `{}` (mutan), jsonwebtoken
    // TIDAK PUNYA alasan menolak token ini (dibuktikan manual: dengan
    // opsi kosong, jwt.verify menerimanya tanpa error sama sekali).
    const tokenWithDifferentAlgorithm = jwt.sign(
      { id: 'user-1', email: 'budi@example.com', role: 'USER' },
      env.JWT_SECRET,
      { algorithm: 'HS384' }
    );

    expect(() => jwtHelper.verify(tokenWithDifferentAlgorithm)).toThrow('invalid algorithm');
  });

  it('T-mutation (id=339, jalur verifyMfaChallenge) — pembatasan algorithms yang sama juga berlaku di verifyMfaChallenge (satu konstanta JWT_VERIFY_OPTIONS dipakai keduanya)', () => {
    delete process.env.JWT_SECRET_PREVIOUS;
    jest.resetModules();
    const { jwtHelper } = require('./jwt');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { env } = require('../config/env');
    const tokenWithDifferentAlgorithm = jwt.sign(
      { type: 'mfa_challenge', userId: 'user-1' },
      env.JWT_SECRET,
      { algorithm: 'HS384' }
    );

    expect(() => jwtHelper.verifyMfaChallenge(tokenWithDifferentAlgorithm)).toThrow(
      'invalid algorithm'
    );
  });
});
