import { upsertSsoConnectionSchema, ssoCallbackQuerySchema, consumeSsoCodeSchema } from './sso.dto';

describe('upsertSsoConnectionSchema', () => {
  const validInput = {
    issuerUrl: 'https://login.microsoftonline.com/tenant-id/v2.0',
    clientId: 'client-abc',
    clientSecret: 'super-secret-value',
    allowedEmailDomain: 'acme.com',
  };

  it('menerima input valid dan menerapkan default enabled:true', () => {
    const result = upsertSsoConnectionSchema.parse(validInput);
    expect(result.enabled).toBe(true);
  });

  it('menerima enabled:false eksplisit', () => {
    const result = upsertSsoConnectionSchema.parse({ ...validInput, enabled: false });
    expect(result.enabled).toBe(false);
  });

  it('menolak issuerUrl yang bukan URL valid', () => {
    expect(
      upsertSsoConnectionSchema.safeParse({ ...validInput, issuerUrl: 'bukan-url' }).success
    ).toBe(false);
  });

  it('menolak clientId/clientSecret kosong', () => {
    expect(upsertSsoConnectionSchema.safeParse({ ...validInput, clientId: '' }).success).toBe(
      false
    );
    expect(upsertSsoConnectionSchema.safeParse({ ...validInput, clientSecret: '' }).success).toBe(
      false
    );
  });

  it('menolak allowedEmailDomain yang menyertakan "@" (harus domain saja, bukan email)', () => {
    expect(
      upsertSsoConnectionSchema.safeParse({ ...validInput, allowedEmailDomain: '@acme.com' })
        .success
    ).toBe(false);
  });

  it('menolak allowedEmailDomain tanpa titik (bukan domain valid)', () => {
    expect(
      upsertSsoConnectionSchema.safeParse({ ...validInput, allowedEmailDomain: 'acme' }).success
    ).toBe(false);
  });

  it('menerima allowedEmailDomain dengan subdomain', () => {
    expect(
      upsertSsoConnectionSchema.safeParse({ ...validInput, allowedEmailDomain: 'corp.acme.com' })
        .success
    ).toBe(true);
  });
});

describe('ssoCallbackQuerySchema', () => {
  it('menerima code+state (jalur sukses)', () => {
    const result = ssoCallbackQuerySchema.parse({ code: 'abc', state: 'xyz' });
    expect(result).toEqual({ code: 'abc', state: 'xyz' });
  });

  it('menerima error+error_description TANPA code (jalur ditolak IdP)', () => {
    const result = ssoCallbackQuerySchema.parse({
      state: 'xyz',
      error: 'access_denied',
      error_description: 'User membatalkan',
    });
    expect(result.code).toBeUndefined();
    expect(result.error).toBe('access_denied');
  });

  it('menolak kalau state tidak ada sama sekali', () => {
    expect(ssoCallbackQuerySchema.safeParse({ code: 'abc' }).success).toBe(false);
  });

  it('menolak kalau state string kosong', () => {
    expect(ssoCallbackQuerySchema.safeParse({ code: 'abc', state: '' }).success).toBe(false);
  });
});

describe('consumeSsoCodeSchema', () => {
  it('menerima code non-kosong', () => {
    expect(consumeSsoCodeSchema.safeParse({ code: 'kode-tukar' }).success).toBe(true);
  });

  it('menolak code kosong atau tidak ada', () => {
    expect(consumeSsoCodeSchema.safeParse({ code: '' }).success).toBe(false);
    expect(consumeSsoCodeSchema.safeParse({}).success).toBe(false);
  });
});
