import { getPermissionsForRole } from '../../shared/security/permissions';
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

  describe('batas ukuran scopes', () => {
    const maxCount = getPermissionsForRole('ADMIN').length;

    it.each(['USER', 'ORGANIZER', 'ADMIN'] as const)(
      'menerima SELURUH permission milik role %s (batas jumlah tidak boleh lebih kecil dari role mana pun)',
      (role) => {
        const scopes = [...getPermissionsForRole(role)];

        expect(createApiKeySchema.safeParse({ name: 'Key', scopes }).success).toBe(true);
      }
    );

    it('menerima scopes kosong (artinya: warisi seluruh permission pemilik)', () => {
      expect(createApiKeySchema.safeParse({ name: 'Key', scopes: [] }).success).toBe(true);
    });

    it('menerima tepat batas jumlah, menolak satu di atasnya dengan pesan jumlah', () => {
      const atLimit = Array.from({ length: maxCount }, () => 'event.read');
      const overLimit = Array.from({ length: maxCount + 1 }, () => 'event.read');

      expect(createApiKeySchema.safeParse({ name: 'Key', scopes: atLimit }).success).toBe(true);
      const result = createApiKeySchema.safeParse({ name: 'Key', scopes: overLimit });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].path).toEqual(['scopes']);
        expect(result.error.issues[0].message).toBe('Jumlah scope melebihi batas yang diizinkan');
      }
    });

    it('array jauh melebihi batas menghasilkan SATU isu saja (elemen tidak diperiksa satu per satu)', () => {
      const huge = Array.from({ length: 5000 }, () => 'x'.repeat(100));

      const result = createApiKeySchema.safeParse({ name: 'Key', scopes: huge });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
      }
    });

    it('menerima scope sepanjang 64 karakter, menolak 65 dengan pesan panjang', () => {
      expect(createApiKeySchema.safeParse({ name: 'Key', scopes: ['a'.repeat(64)] }).success).toBe(
        true
      );
      const result = createApiKeySchema.safeParse({ name: 'Key', scopes: ['a'.repeat(65)] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Panjang scope melebihi batas yang diizinkan');
      }
    });

    it('menolak elemen scopes yang bukan string', () => {
      expect(createApiKeySchema.safeParse({ name: 'Key', scopes: [123] }).success).toBe(false);
    });
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
