const resolvePlanByIdMock = jest.fn();

jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../../modules/tenants/tenant.repository', () => ({ TenantRepository: jest.fn() }));
jest.mock('../../modules/tenants/tenant.service', () => ({
  TenantService: jest.fn().mockImplementation(() => ({ resolvePlanById: resolvePlanByIdMock })),
}));

import { resolveTenantPlanSafe } from './tenant-plan';

describe('resolveTenantPlanSafe (item 2.11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tenantId null (API key tanpa tenant, masa transisi Phase 11) -> null TANPA query apa pun', async () => {
    await expect(resolveTenantPlanSafe(null)).resolves.toBeNull();
    expect(resolvePlanByIdMock).not.toHaveBeenCalled();
  });

  it('mengembalikan plan dari TenantService.resolvePlanById', async () => {
    resolvePlanByIdMock.mockResolvedValue('ENTERPRISE');

    await expect(resolveTenantPlanSafe('tenant-1')).resolves.toBe('ENTERPRISE');
    expect(resolvePlanByIdMock).toHaveBeenCalledWith('tenant-1');
  });

  it('tenant tidak ada (service mengembalikan null) -> null, bukan error', async () => {
    resolvePlanByIdMock.mockResolvedValue(null);

    await expect(resolveTenantPlanSafe('hilang')).resolves.toBeNull();
  });

  it('FAIL-SOFT — lookup melempar (mis. database lambat/error) -> null (tier default), TIDAK melempar ke pemanggil', async () => {
    resolvePlanByIdMock.mockRejectedValue(new Error('connection timeout'));

    await expect(resolveTenantPlanSafe('tenant-1')).resolves.toBeNull();
  });
});
