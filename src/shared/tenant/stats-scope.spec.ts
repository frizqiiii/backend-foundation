import { assertPlatformScope } from './stats-scope';
import { runWithTenantContext } from './tenant-context';
import { ForbiddenError } from '../utils/http-error';

describe('assertPlatformScope (R21)', () => {
  it('tanpa konteks tenant (mode platform): lolos', () => {
    expect(() => assertPlatformScope()).not.toThrow();
    expect(() =>
      runWithTenantContext({ tenantId: null, tenantSlug: null, db: null }, () =>
        assertPlatformScope()
      )
    ).not.toThrow();
  });

  it('dengan tenant aktif (mode tenant): ForbiddenError', () => {
    expect(() =>
      runWithTenantContext({ tenantId: 'tenant-1', tenantSlug: 'acme', db: null }, () =>
        assertPlatformScope()
      )
    ).toThrow(ForbiddenError);
  });
});
