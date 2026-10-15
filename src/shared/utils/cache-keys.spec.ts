import { cacheKeys } from './cache-keys';

describe('cacheKeys', () => {
  it('userProfile', () => {
    expect(cacheKeys.userProfile('user-1')).toBe('cache:user:profile:user-1');
  });

  it('productsListPattern / productsList', () => {
    expect(cacheKeys.productsListPattern()).toBe('cache:products:list:*');
    expect(cacheKeys.productsList('page=1&limit=20')).toBe('cache:products:list:page=1&limit=20');
  });

  it('eventsListPattern / eventsList', () => {
    expect(cacheKeys.eventsListPattern()).toBe('cache:events:list:*');
    expect(cacheKeys.eventsList('tenant-1', 'category=Musik')).toBe(
      'cache:events:list:tenant-1:category=Musik'
    );
    // S2: tenant berbeda + query sama HARUS menghasilkan kunci berbeda.
    expect(cacheKeys.eventsList('tenant-1', 'q')).not.toBe(cacheKeys.eventsList('tenant-2', 'q'));
    // ...dan tetap tercakup oleh pola invalidasi wildcard.
    expect(cacheKeys.eventsList('tenant-1', 'q').startsWith('cache:events:list:')).toBe(true);
  });

  it('featureFlag', () => {
    expect(cacheKeys.featureFlag('new-checkout-flow')).toBe('cache:feature-flag:new-checkout-flow');
  });

  it('tenantBySlug', () => {
    expect(cacheKeys.tenantBySlug('acme-corp')).toBe('cache:tenant:slug:acme-corp');
  });

  it('T-mutation (id=194) — tenantPlanById MEMBAWA tenantId ke dalam key (bukan konstanta kosong) — kalau tidak, SEMUA tenant akan berbagi satu cache plan yang sama', () => {
    expect(cacheKeys.tenantPlanById('tenant-abc')).toBe('cache:tenant:plan:tenant-abc');
    // Dua tenant BEDA harus dapat key BEDA — ini yang benar-benar
    // rusak kalau template string-nya jadi konstanta kosong (mutan).
    expect(cacheKeys.tenantPlanById('tenant-abc')).not.toBe(cacheKeys.tenantPlanById('tenant-xyz'));
  });

  it('T-mutation (id=196) — tenantStatusById MEMBAWA tenantId ke dalam key (bukan konstanta kosong) — kalau tidak, suspend satu tenant bisa salah menimpa/menghapus cache status tenant lain', () => {
    expect(cacheKeys.tenantStatusById('tenant-abc')).toBe('cache:tenant:status:tenant-abc');
    expect(cacheKeys.tenantStatusById('tenant-abc')).not.toBe(
      cacheKeys.tenantStatusById('tenant-xyz')
    );
  });
});
