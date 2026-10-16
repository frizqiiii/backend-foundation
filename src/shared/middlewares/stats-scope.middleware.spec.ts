import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/http-error';
import { runWithTenantContext } from '../tenant/tenant-context';

const findByIdMock = jest.fn();

jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../../modules/users/user.repository', () => ({
  UserRepository: jest.fn().mockImplementation(() => ({ findById: findByIdMock })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requireTenantOrPlatformAdmin } = require('./stats-scope.middleware');

const reqOf = (user?: Record<string, unknown>): Request => ({ user }) as unknown as Request;

async function run(tenantId: string | null, user?: Record<string, unknown>): Promise<jest.Mock> {
  const next = jest.fn();
  await runWithTenantContext({ tenantId, tenantSlug: tenantId, db: null }, () =>
    requireTenantOrPlatformAdmin(reqOf(user), {} as Response, next as NextFunction)
  );
  return next;
}

describe('requireTenantOrPlatformAdmin (R21)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('tanpa req.user: UnauthorizedError', async () => {
    expect(await run(null, undefined)).toHaveBeenCalledWith(expect.any(UnauthorizedError));
  });

  it('dengan header tenant: lolos tanpa query user (ikatan tenant sudah ditegakkan authMiddleware)', async () => {
    const next = await run('tenant-1', { id: 'u1', role: 'ADMIN' });
    expect(next).toHaveBeenCalledWith();
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('tanpa header: ADMIN tanpa tenant (admin platform) lolos', async () => {
    findByIdMock.mockResolvedValue({ id: 'u1', role: 'ADMIN', tenantId: null });
    expect(await run(null, { id: 'u1', role: 'ADMIN' })).toHaveBeenCalledWith();
  });

  it('tanpa header: ADMIN yang terikat tenant DITOLAK (tidak boleh melihat angka global)', async () => {
    findByIdMock.mockResolvedValue({ id: 'u1', role: 'ADMIN', tenantId: 'tenant-1' });
    expect(await run(null, { id: 'u1', role: 'ADMIN' })).toHaveBeenCalledWith(
      expect.any(ForbiddenError)
    );
  });

  it('tanpa header: non-ADMIN tanpa tenant DITOLAK', async () => {
    findByIdMock.mockResolvedValue({ id: 'u1', role: 'USER', tenantId: null });
    expect(await run(null, { id: 'u1', role: 'USER' })).toHaveBeenCalledWith(
      expect.any(ForbiddenError)
    );
  });

  it('tanpa header: user sudah tidak ada DITOLAK', async () => {
    findByIdMock.mockResolvedValue(null);
    expect(await run(null, { id: 'u1', role: 'ADMIN' })).toHaveBeenCalledWith(
      expect.any(ForbiddenError)
    );
  });

  it('tanpa header + API key: DITOLAK tanpa query user (key bisa terikat tenant)', async () => {
    const next = await run(null, { id: 'u1', role: 'ADMIN', apiKeyScopes: ['dashboard.read'] });
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
