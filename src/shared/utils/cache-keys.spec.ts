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
    expect(cacheKeys.eventsList('category=Musik')).toBe('cache:events:list:category=Musik');
  });

  it('featureFlag', () => {
    expect(cacheKeys.featureFlag('new-checkout-flow')).toBe('cache:feature-flag:new-checkout-flow');
  });

  it('tenantBySlug', () => {
    expect(cacheKeys.tenantBySlug('acme-corp')).toBe('cache:tenant:slug:acme-corp');
  });
});
