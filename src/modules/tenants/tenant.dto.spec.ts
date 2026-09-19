import { createTenantSchema, listTenantsQuerySchema, updateTenantPlanSchema } from './tenant.dto';

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

  it('item 2.11 — `plan` OPSIONAL (tidak diisi = default database) dan hanya menerima FREE/PRO/ENTERPRISE', () => {
    expect(createTenantSchema.parse({ slug: 'acme', name: 'Acme' }).plan).toBeUndefined();
    for (const plan of ['FREE', 'PRO', 'ENTERPRISE']) {
      expect(createTenantSchema.safeParse({ slug: 'acme', name: 'Acme', plan }).success).toBe(true);
    }
    expect(createTenantSchema.safeParse({ slug: 'acme', name: 'Acme', plan: 'GOLD' }).success).toBe(
      false
    );
    // case-sensitive — sama dengan nilai enum Postgres
    expect(createTenantSchema.safeParse({ slug: 'acme', name: 'Acme', plan: 'free' }).success).toBe(
      false
    );
  });
});

describe('updateTenantPlanSchema (item 2.11)', () => {
  it('menerima plan yang valid', () => {
    expect(updateTenantPlanSchema.parse({ plan: 'ENTERPRISE' })).toEqual({ plan: 'ENTERPRISE' });
  });

  it('menolak body tanpa plan atau dengan plan tak dikenal', () => {
    expect(updateTenantPlanSchema.safeParse({}).success).toBe(false);
    expect(updateTenantPlanSchema.safeParse({ plan: 'GOLD' }).success).toBe(false);
  });

  it('membuang field lain (mis. mencoba mengubah `status`/`slug` lewat endpoint ini) — hanya plan yang lolos', () => {
    expect(updateTenantPlanSchema.parse({ plan: 'FREE', status: 'SUSPENDED', slug: 'x' })).toEqual({
      plan: 'FREE',
    });
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
