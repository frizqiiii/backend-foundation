import {
  registerSchema,
  resetPasswordSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  googleLoginSchema,
  githubLoginSchema,
  paginationQuerySchema,
} from './auth.dto';

describe('password policy (Phase 5 — Security Hardening)', () => {
  const validPayloadWith = (password: string) => ({
    name: 'Budi Santoso',
    email: 'budi@example.com',
    password,
  });

  it('menerima password yang memenuhi seluruh syarat (huruf besar, huruf kecil, angka, minimal 8 karakter)', () => {
    const result = registerSchema.safeParse(validPayloadWith('Password123'));
    expect(result.success).toBe(true);
  });

  it('menolak password kurang dari 8 karakter', () => {
    const result = registerSchema.safeParse(validPayloadWith('Aa1'));
    expect(result.success).toBe(false);
  });

  it('menolak password TANPA huruf besar', () => {
    const result = registerSchema.safeParse(validPayloadWith('password123'));
    expect(result.success).toBe(false);
  });

  it('menolak password TANPA huruf kecil', () => {
    const result = registerSchema.safeParse(validPayloadWith('PASSWORD123'));
    expect(result.success).toBe(false);
  });

  it('menolak password TANPA angka', () => {
    const result = registerSchema.safeParse(validPayloadWith('PasswordSaja'));
    expect(result.success).toBe(false);
  });

  it('resetPasswordSchema menegakkan aturan yang SAMA persis dengan registerSchema — tidak boleh diam-diam berbeda', () => {
    const weak = resetPasswordSchema.safeParse({ token: 'valid-token', newPassword: 'lemah' });
    const strong = resetPasswordSchema.safeParse({
      token: 'valid-token',
      newPassword: 'PasswordBaru123',
    });

    expect(weak.success).toBe(false);
    expect(strong.success).toBe(true);
  });
});

describe('P5 — registerSchema (field lain di luar password)', () => {
  it('menolak name kurang dari 2 karakter', () => {
    expect(
      registerSchema.safeParse({ name: 'B', email: 'budi@example.com', password: 'Password123' })
        .success
    ).toBe(false);
  });

  it('menolak email tidak valid', () => {
    expect(
      registerSchema.safeParse({ name: 'Budi', email: 'bukan-email', password: 'Password123' })
        .success
    ).toBe(false);
  });
});

describe('P5 — loginSchema', () => {
  it('menerima email + password apa saja (TIDAK menegakkan kebijakan kompleksitas saat login)', () => {
    expect(loginSchema.safeParse({ email: 'budi@example.com', password: 'x' }).success).toBe(true);
  });

  it('menolak password kosong atau email tidak valid', () => {
    expect(loginSchema.safeParse({ email: 'budi@example.com', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'bukan-email', password: 'x' }).success).toBe(false);
  });
});

describe('P5 — refreshSchema / logoutSchema', () => {
  it('menerima refreshToken yang diisi, menolak kosong', () => {
    expect(refreshSchema.safeParse({ refreshToken: 'token-abc' }).success).toBe(true);
    expect(refreshSchema.safeParse({ refreshToken: '' }).success).toBe(false);
    expect(logoutSchema.safeParse({ refreshToken: 'token-abc' }).success).toBe(true);
    expect(logoutSchema.safeParse({ refreshToken: '' }).success).toBe(false);
  });
});

describe('P5 — verifyEmailSchema / forgotPasswordSchema / googleLoginSchema / githubLoginSchema', () => {
  it('masing-masing menerima field wajibnya, menolak kalau kosong/tidak valid', () => {
    expect(verifyEmailSchema.safeParse({ token: 'tok' }).success).toBe(true);
    expect(verifyEmailSchema.safeParse({ token: '' }).success).toBe(false);

    expect(forgotPasswordSchema.safeParse({ email: 'budi@example.com' }).success).toBe(true);
    expect(forgotPasswordSchema.safeParse({ email: 'bukan-email' }).success).toBe(false);

    expect(googleLoginSchema.safeParse({ idToken: 'id-token' }).success).toBe(true);
    expect(googleLoginSchema.safeParse({ idToken: '' }).success).toBe(false);

    expect(githubLoginSchema.safeParse({ code: 'auth-code' }).success).toBe(true);
    expect(githubLoginSchema.safeParse({ code: '' }).success).toBe(false);
  });
});

describe('P5 — paginationQuerySchema', () => {
  it('menerapkan default page:1 limit:20, meng-coerce string, dan membatasi limit maksimal 100', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(paginationQuerySchema.parse({ page: '2', limit: '50' })).toEqual({
      page: 2,
      limit: 50,
    });
    expect(paginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});
