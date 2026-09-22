const isActiveByIdMock = jest.fn();

jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../../modules/tenants/tenant.repository', () => ({ TenantRepository: jest.fn() }));
jest.mock('../../modules/tenants/tenant.service', () => ({
  TenantService: jest.fn().mockImplementation(() => ({ isActiveById: isActiveByIdMock })),
}));

import { isTenantActiveForApiKey } from './tenant-status';

describe('isTenantActiveForApiKey (T3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tenantId null (API key tanpa tenant, masa transisi Phase 11) -> true TANPA query apa pun', async () => {
    await expect(isTenantActiveForApiKey(null)).resolves.toBe(true);
    expect(isActiveByIdMock).not.toHaveBeenCalled();
  });

  it('mendelegasikan ke TenantService.isActiveById dan meneruskan hasilnya', async () => {
    isActiveByIdMock.mockResolvedValue(true);
    await expect(isTenantActiveForApiKey('tenant-1')).resolves.toBe(true);
    expect(isActiveByIdMock).toHaveBeenCalledWith('tenant-1');

    isActiveByIdMock.mockResolvedValue(false);
    await expect(isTenantActiveForApiKey('tenant-1')).resolves.toBe(false);
  });

  it('FAIL-CLOSED (beda dari resolveTenantPlanSafe yang fail-soft) — lookup melempar -> error MENJALAR ke pemanggil, bukan diam-diam dianggap aktif', async () => {
    isActiveByIdMock.mockRejectedValue(new Error('connection timeout'));

    await expect(isTenantActiveForApiKey('tenant-1')).rejects.toThrow('connection timeout');
  });
});
