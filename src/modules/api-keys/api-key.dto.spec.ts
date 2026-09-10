import { createApiKeySchema } from './api-key.dto';

describe('createApiKeySchema', () => {
  it('menerima name saja (scopes/expiresAt opsional)', () => {
    const result = createApiKeySchema.safeParse({ name: 'CI pipeline' });
    expect(result.success).toBe(true);
  });

  it('menolak name kosong', () => {
    expect(createApiKeySchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('menolak name lebih dari 100 karakter', () => {
    expect(createApiKeySchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });

  it('menerima scopes berupa array string', () => {
    const result = createApiKeySchema.parse({ name: 'Key', scopes: ['event.read'] });
    expect(result.scopes).toEqual(['event.read']);
  });

  it('menerima expiresAt dalam format ISO 8601 datetime', () => {
    const result = createApiKeySchema.safeParse({
      name: 'Key',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('menolak expiresAt yang bukan format ISO 8601 datetime valid', () => {
    expect(createApiKeySchema.safeParse({ name: 'Key', expiresAt: '2027-01-01' }).success).toBe(
      false
    );
  });
});
