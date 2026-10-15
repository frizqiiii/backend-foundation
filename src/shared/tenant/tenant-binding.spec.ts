import { ForbiddenError } from '../utils/http-error';
import { assertTenantBinding } from './tenant-binding';

describe('assertTenantBinding (S1)', () => {
  it('tanpa header tenant: lolos untuk siapa pun, termasuk user bertenant', () => {
    expect(() =>
      assertTenantBinding({ requestedTenantId: null, boundTenantId: 'tenant-a', role: 'USER' })
    ).not.toThrow();
    expect(() =>
      assertTenantBinding({ requestedTenantId: null, boundTenantId: null, role: 'USER' })
    ).not.toThrow();
  });

  it('header sama dengan tenant terikat: lolos', () => {
    expect(() =>
      assertTenantBinding({
        requestedTenantId: 'tenant-a',
        boundTenantId: 'tenant-a',
        role: 'USER',
      })
    ).not.toThrow();
  });

  it('header BEDA dari tenant terikat: ditolak 403, juga untuk ADMIN yang punya tenant', () => {
    for (const role of ['USER', 'ORGANIZER', 'ADMIN'] as const) {
      expect(() =>
        assertTenantBinding({ requestedTenantId: 'tenant-b', boundTenantId: 'tenant-a', role })
      ).toThrow(ForbiddenError);
    }
  });

  it('tenant terikat null + ADMIN (akun platform): boleh memilih tenant mana pun', () => {
    expect(() =>
      assertTenantBinding({ requestedTenantId: 'tenant-b', boundTenantId: null, role: 'ADMIN' })
    ).not.toThrow();
  });

  it('tenant terikat null + non-ADMIN: ditolak (fail-closed)', () => {
    for (const role of ['USER', 'ORGANIZER'] as const) {
      expect(() =>
        assertTenantBinding({ requestedTenantId: 'tenant-b', boundTenantId: null, role })
      ).toThrow(ForbiddenError);
    }
  });
});
