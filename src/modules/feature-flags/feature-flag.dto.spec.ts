import { upsertFeatureFlagSchema } from './feature-flag.dto';

describe('upsertFeatureFlagSchema', () => {
  it('menerima enabled saja (description opsional)', () => {
    expect(upsertFeatureFlagSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it('menolak kalau enabled tidak diisi', () => {
    expect(upsertFeatureFlagSchema.safeParse({}).success).toBe(false);
  });

  it('menolak enabled yang bukan boolean', () => {
    expect(upsertFeatureFlagSchema.safeParse({ enabled: 'true' }).success).toBe(false);
  });

  it('menolak description lebih dari 500 karakter', () => {
    expect(
      upsertFeatureFlagSchema.safeParse({ enabled: true, description: 'a'.repeat(501) }).success
    ).toBe(false);
  });

  it('menerima description sampai 500 karakter', () => {
    expect(
      upsertFeatureFlagSchema.safeParse({ enabled: true, description: 'a'.repeat(500) }).success
    ).toBe(true);
  });
});
