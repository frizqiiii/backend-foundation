import { confirmMfaSetupSchema, disableMfaSchema, verifyMfaLoginSchema } from './mfa.dto';

describe('confirmMfaSetupSchema', () => {
  it('menerima kode 6 digit angka', () => {
    expect(confirmMfaSetupSchema.safeParse({ code: '123456' }).success).toBe(true);
  });

  it('menolak kode kurang dari 6 digit', () => {
    expect(confirmMfaSetupSchema.safeParse({ code: '12345' }).success).toBe(false);
  });

  it('menolak kode lebih dari 6 digit', () => {
    expect(confirmMfaSetupSchema.safeParse({ code: '1234567' }).success).toBe(false);
  });

  it('menolak kode yang mengandung huruf', () => {
    expect(confirmMfaSetupSchema.safeParse({ code: '12a456' }).success).toBe(false);
  });
});

describe('disableMfaSchema', () => {
  it('menerima password yang diisi', () => {
    expect(disableMfaSchema.safeParse({ password: 'secret123' }).success).toBe(true);
  });

  it('menolak password kosong', () => {
    expect(disableMfaSchema.safeParse({ password: '' }).success).toBe(false);
  });
});

describe('verifyMfaLoginSchema', () => {
  it('menerima challengeToken + kode TOTP 6 digit', () => {
    const result = verifyMfaLoginSchema.safeParse({
      challengeToken: 'token-abc',
      code: '123456',
    });
    expect(result.success).toBe(true);
  });

  it('P5 — menerima challengeToken + recovery code format panjang (XXXXX-XXXXX)', () => {
    const result = verifyMfaLoginSchema.safeParse({
      challengeToken: 'token-abc',
      code: 'ABCDE-12345',
    });
    expect(result.success).toBe(true);
  });

  it('menolak challengeToken kosong', () => {
    expect(verifyMfaLoginSchema.safeParse({ challengeToken: '', code: '123456' }).success).toBe(
      false
    );
  });

  it('menolak code kurang dari 6 karakter', () => {
    expect(
      verifyMfaLoginSchema.safeParse({ challengeToken: 'token-abc', code: '123' }).success
    ).toBe(false);
  });

  it('menolak code lebih dari 20 karakter', () => {
    expect(
      verifyMfaLoginSchema.safeParse({ challengeToken: 'token-abc', code: 'a'.repeat(21) }).success
    ).toBe(false);
  });
});
