import { createTenantSchema, listTenantsQuerySchema } from './tenant.dto';

describe('createTenantSchema', () => {
  it('menerima slug dan name yang valid', () => {
    const result = createTenantSchema.safeParse({ slug: 'acme-corp', name: 'Acme Corp' });
    expect(result.success).toBe(true);
  });

  it('menolak slug dengan huruf besar', () => {
    expect(createTenantSchema.safeParse({ slug: 'Acme-Corp', name: 'Acme' }).success).toBe(false);
  });

  it('menolak slug dengan underscore/spasi/karakter selain huruf-kecil-angka-hubung', () => {
    expect(createTenantSchema.safeParse({ slug: 'acme_corp', name: 'Acme' }).success).toBe(false);
    expect(createTenantSchema.safeParse({ slug: 'acme corp', name: 'Acme' }).success).toBe(false);
  });

  it('menolak slug diawali/diakhiri tanda hubung (pola regex mengharuskan diapit huruf/angka)', () => {
    expect(createTenantSchema.safeParse({ slug: '-acme', name: 'Acme' }).success).toBe(false);
    expect(createTenantSchema.safeParse({ slug: 'acme-', name: 'Acme' }).success).toBe(false);
  });

  it('menolak slug kurang dari 2 karakter atau lebih dari 63 karakter', () => {
    expect(createTenantSchema.safeParse({ slug: 'a', name: 'Acme' }).success).toBe(false);
    expect(createTenantSchema.safeParse({ slug: 'a'.repeat(64), name: 'Acme' }).success).toBe(
      false
    );
  });

  it('menolak name kosong', () => {
    expect(createTenantSchema.safeParse({ slug: 'acme', name: '' }).success).toBe(false);
  });
});

describe('listTenantsQuerySchema', () => {
  it('menerapkan default page:1 limit:20', () => {
    expect(listTenantsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it('meng-coerce dan memvalidasi batas page/limit sama seperti skema list lain', () => {
    expect(listTenantsQuerySchema.parse({ page: '2', limit: '30' })).toEqual({
      page: 2,
      limit: 30,
    });
    expect(listTenantsQuerySchema.safeParse({ limit: '999' }).success).toBe(false);
  });
});
