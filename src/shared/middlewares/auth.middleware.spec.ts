import type { Request, Response, NextFunction } from 'express';
import { UnauthorizedError, NotFoundError, ForbiddenError } from '../utils/http-error';
import { runWithTenantContext } from '../tenant/tenant-context';

const jwtVerifyMock = jest.fn();
const isBlacklistedMock = jest.fn();
const apiKeyAuthenticateMock = jest.fn();
const findByIdMock = jest.fn();
const enforceGatewayMock = jest.fn();
const resolveTenantPlanSafeMock = jest.fn();
const isTenantActiveForApiKeyMock = jest.fn();

jest.mock('../utils/jwt', () => ({ jwtHelper: { verify: jwtVerifyMock } }));
jest.mock('../utils/token-blacklist', () => ({
  tokenBlacklist: { isBlacklisted: isBlacklistedMock },
}));
jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../security/api-key-gateway', () => ({
  enforcePartnerApiGatewayLimit: enforceGatewayMock,
}));
jest.mock('../tenant/tenant-plan', () => ({ resolveTenantPlanSafe: resolveTenantPlanSafeMock }));
jest.mock('../tenant/tenant-status', () => ({
  isTenantActiveForApiKey: isTenantActiveForApiKeyMock,
}));
jest.mock('../../modules/api-keys/api-key.service', () => ({
  ApiKeyService: jest.fn().mockImplementation(() => ({ authenticate: apiKeyAuthenticateMock })),
}));
jest.mock('../../modules/api-keys/api-key.repository', () => ({ ApiKeyRepository: jest.fn() }));
jest.mock('../../modules/users/user.repository', () => ({
  UserRepository: jest.fn().mockImplementation(() => ({ findById: findByIdMock })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authMiddleware } = require('./auth.middleware');

function createMockReq(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as unknown as Request;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isBlacklistedMock.mockResolvedValue(false);
    enforceGatewayMock.mockResolvedValue(undefined);
    resolveTenantPlanSafeMock.mockResolvedValue(null);
    isTenantActiveForApiKeyMock.mockResolvedValue(true);
  });

  describe('S1 — tenant dari header terikat ke identitas', () => {
    const jwtPayload = (role: string) => ({
      id: 'user-1',
      email: 'budi@example.com',
      role,
      jti: 'jti-1',
      exp: 9999999999,
    });

    function inTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
      return runWithTenantContext({ tenantId, tenantSlug: null, db: null }, fn);
    }

    async function runJwt(
      requested: string | null,
      role = 'USER'
    ): Promise<{ next: jest.Mock; req: Request }> {
      jwtVerifyMock.mockReturnValue(jwtPayload(role));
      const req = createMockReq('Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature');
      const next = jest.fn();
      await inTenant(requested, () => authMiddleware(req, {} as Response, next as NextFunction));
      return { next, req };
    }

    it('JWT: tanpa header tenant -> TIDAK ada query user tambahan (tidak mengubah perilaku lama)', async () => {
      const { next } = await runJwt(null);
      expect(next).toHaveBeenCalledWith();
      expect(findByIdMock).not.toHaveBeenCalled();
    });

    it('JWT: header = tenant milik user -> lolos dan req.user terisi', async () => {
      findByIdMock.mockResolvedValue({ id: 'user-1', tenantId: 'tenant-a' });
      const { next, req } = await runJwt('tenant-a');
      expect(next).toHaveBeenCalledWith();
      expect(req.user?.id).toBe('user-1');
    });

    it('JWT: header = tenant LAIN -> ForbiddenError dan req.user TIDAK terisi', async () => {
      findByIdMock.mockResolvedValue({ id: 'user-1', tenantId: 'tenant-a' });
      const { next, req } = await runJwt('tenant-b');
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
      expect(req.user).toBeUndefined();
    });

    it('JWT: ADMIN yang punya tenant tetap terikat ke tenantnya', async () => {
      findByIdMock.mockResolvedValue({ id: 'user-1', tenantId: 'tenant-a' });
      const { next } = await runJwt('tenant-b', 'ADMIN');
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('JWT: ADMIN tanpa tenant (platform) boleh memilih tenant mana pun', async () => {
      findByIdMock.mockResolvedValue({ id: 'user-1', tenantId: null });
      const { next } = await runJwt('tenant-b', 'ADMIN');
      expect(next).toHaveBeenCalledWith();
    });

    it('JWT: USER tanpa tenant + header tenant -> ForbiddenError (fail-closed)', async () => {
      findByIdMock.mockResolvedValue({ id: 'user-1', tenantId: null });
      const { next } = await runJwt('tenant-b', 'USER');
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('JWT: user sudah tidak ada/terhapus + header tenant -> UnauthorizedError', async () => {
      findByIdMock.mockResolvedValue(null);
      const { next } = await runJwt('tenant-a');
      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });

    function apiKeyAuth(keyTenantId: string | null): void {
      apiKeyAuthenticateMock.mockResolvedValue({
        apiKeyId: 'key-1',
        userId: 'user-1',
        tenantId: keyTenantId,
        scopes: [],
        expiresAt: null,
      });
    }

    async function runKey(requested: string | null): Promise<jest.Mock> {
      const next = jest.fn();
      await inTenant(requested, () =>
        authMiddleware(createMockReq('Bearer bfk_abc123'), {} as Response, next as NextFunction)
      );
      return next;
    }

    it('API key: header = tenant key -> lolos', async () => {
      apiKeyAuth('tenant-a');
      findByIdMock.mockResolvedValue({
        id: 'user-1',
        email: 'b@e.com',
        role: 'USER',
        tenantId: 'tenant-a',
      });
      expect(await runKey('tenant-a')).toHaveBeenCalledWith();
    });

    it('API key: header = tenant LAIN -> ForbiddenError', async () => {
      apiKeyAuth('tenant-a');
      findByIdMock.mockResolvedValue({
        id: 'user-1',
        email: 'b@e.com',
        role: 'USER',
        tenantId: 'tenant-a',
      });
      expect(await runKey('tenant-b')).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('API key tanpa tenant memakai tenant pemilik sebagai pengikat', async () => {
      apiKeyAuth(null);
      findByIdMock.mockResolvedValue({
        id: 'user-1',
        email: 'b@e.com',
        role: 'USER',
        tenantId: 'tenant-a',
      });
      expect(await runKey('tenant-a')).toHaveBeenCalledWith();
      expect(await runKey('tenant-b')).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('API key: tenant KEY mengalahkan tenant pemilik (key tenant-a milik user bertenant-b hanya boleh memilih tenant-a)', async () => {
      apiKeyAuth('tenant-a');
      findByIdMock.mockResolvedValue({
        id: 'user-1',
        email: 'b@e.com',
        role: 'USER',
        tenantId: 'tenant-b',
      });
      expect(await runKey('tenant-a')).toHaveBeenCalledWith();
      expect(await runKey('tenant-b')).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('API key: tanpa header tenant -> perilaku lama (lolos)', async () => {
      apiKeyAuth('tenant-a');
      findByIdMock.mockResolvedValue({
        id: 'user-1',
        email: 'b@e.com',
        role: 'USER',
        tenantId: 'tenant-a',
      });
      expect(await runKey(null)).toHaveBeenCalledWith();
    });
  });

  it('melempar UnauthorizedError kalau header Authorization tidak ada', async () => {
    const next = jest.fn() as NextFunction;
    await authMiddleware(createMockReq(), {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
  });

  it('jalur JWT tetap berjalan seperti biasa untuk token yang BUKAN API key', async () => {
    jwtVerifyMock.mockReturnValue({
      id: 'user-1',
      email: 'budi@example.com',
      role: 'USER',
      jti: 'jti-1',
      exp: 9999999999,
    });

    const req = createMockReq('Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature');
    const next = jest.fn() as NextFunction;
    await authMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({
      id: 'user-1',
      email: 'budi@example.com',
      role: 'USER',
      jti: 'jti-1',
      exp: 9999999999,
    });
    expect(apiKeyAuthenticateMock).not.toHaveBeenCalled();
  });

  it('mendelegasikan ke ApiKeyService untuk token berawalan bfk_, mengisi req.user dari pemilik key + scopes', async () => {
    apiKeyAuthenticateMock.mockResolvedValue({
      apiKeyId: 'key-1',
      userId: 'user-1',
      scopes: ['event.read'],
      expiresAt: null,
    });
    findByIdMock.mockResolvedValue({ id: 'user-1', email: 'budi@example.com', role: 'USER' });

    const req = createMockReq('Bearer bfk_abc123');
    const next = jest.fn() as NextFunction;
    await authMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({
      id: 'user-1',
      email: 'budi@example.com',
      role: 'USER',
      jti: 'api-key:key-1',
      apiKeyScopes: ['event.read'],
    });
  });

  it('item 2.11 — kuota gateway dipilih dari plan TENANT pemilik key (tenantId dari authenticate -> resolveTenantPlanSafe -> enforcePartnerApiGatewayLimit)', async () => {
    apiKeyAuthenticateMock.mockResolvedValue({
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-acme',
      scopes: [],
      expiresAt: null,
      rateLimitOverridePerMinute: null,
    });
    resolveTenantPlanSafeMock.mockResolvedValue('FREE');
    findByIdMock.mockResolvedValue({ id: 'user-1', email: 'budi@example.com', role: 'USER' });

    const next = jest.fn() as NextFunction;
    await authMiddleware(createMockReq('Bearer bfk_abc123'), {} as Response, next);

    expect(resolveTenantPlanSafeMock).toHaveBeenCalledWith('tenant-acme');
    expect(enforceGatewayMock).toHaveBeenCalledWith('key-1', 'FREE', null);
    expect(next).toHaveBeenCalledWith();
  });

  it('T4 — rateLimitOverridePerMinute dari authenticate() diteruskan apa adanya ke enforcePartnerApiGatewayLimit (TANPA query tambahan)', async () => {
    apiKeyAuthenticateMock.mockResolvedValue({
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-acme',
      scopes: [],
      expiresAt: null,
      rateLimitOverridePerMinute: 750,
    });
    resolveTenantPlanSafeMock.mockResolvedValue('FREE');
    findByIdMock.mockResolvedValue({ id: 'user-1', email: 'budi@example.com', role: 'USER' });

    const next = jest.fn() as NextFunction;
    await authMiddleware(createMockReq('Bearer bfk_abc123'), {} as Response, next);

    expect(enforceGatewayMock).toHaveBeenCalledWith('key-1', 'FREE', 750);
    expect(next).toHaveBeenCalledWith();
  });

  it('item 2.11 — kuota gateway TERLAMPAUI -> error diteruskan ke next() dan pemilik key TIDAK di-query (request ditolak sedini mungkin)', async () => {
    apiKeyAuthenticateMock.mockResolvedValue({
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: null,
      scopes: [],
      expiresAt: null,
    });
    const quotaError = new Error('Kuota API key terlampaui');
    enforceGatewayMock.mockRejectedValue(quotaError);

    const next = jest.fn() as NextFunction;
    await authMiddleware(createMockReq('Bearer bfk_abc123'), {} as Response, next);

    expect(next).toHaveBeenCalledWith(quotaError);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('T3 — tenant pemilik API key SUSPENDED -> ForbiddenError, TIDAK sampai cek kuota gateway maupun query pemilik key (ditegakkan sedini mungkin)', async () => {
    apiKeyAuthenticateMock.mockResolvedValue({
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-suspended',
      scopes: [],
      expiresAt: null,
    });
    isTenantActiveForApiKeyMock.mockResolvedValue(false);

    const next = jest.fn() as NextFunction;
    await authMiddleware(createMockReq('Bearer bfk_abc123'), {} as Response, next);

    expect(isTenantActiveForApiKeyMock).toHaveBeenCalledWith('tenant-suspended');
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    expect(enforceGatewayMock).not.toHaveBeenCalled();
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('T3 — tenant pemilik API key ACTIVE -> berlanjut normal ke pengecekan kuota', async () => {
    apiKeyAuthenticateMock.mockResolvedValue({
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-acme',
      scopes: [],
      expiresAt: null,
    });
    isTenantActiveForApiKeyMock.mockResolvedValue(true);
    findByIdMock.mockResolvedValue({ id: 'user-1', email: 'budi@example.com', role: 'USER' });

    const next = jest.fn() as NextFunction;
    await authMiddleware(createMockReq('Bearer bfk_abc123'), {} as Response, next);

    expect(isTenantActiveForApiKeyMock).toHaveBeenCalledWith('tenant-acme');
    expect(next).toHaveBeenCalledWith();
  });

  it('meneruskan NotFoundError kalau pemilik API key sudah tidak ada', async () => {
    apiKeyAuthenticateMock.mockResolvedValue({
      apiKeyId: 'key-1',
      userId: 'user-1',
      scopes: [],
      expiresAt: null,
    });
    findByIdMock.mockResolvedValue(null);

    const req = createMockReq('Bearer bfk_abc123');
    const next = jest.fn() as NextFunction;
    await authMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
  });

  it('meneruskan error dari ApiKeyService.authenticate (mis. key revoked/kedaluwarsa) ke next()', async () => {
    apiKeyAuthenticateMock.mockRejectedValue(new UnauthorizedError('API key sudah dicabut'));

    const req = createMockReq('Bearer bfk_revoked');
    const next = jest.fn() as NextFunction;
    await authMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
  });

  it('P5 — membalas "Token sudah kadaluarsa" secara spesifik kalau jwtHelper.verify melempar TokenExpiredError', async () => {
    const jwt = require('jsonwebtoken');
    jwtVerifyMock.mockImplementation(() => {
      throw new jwt.TokenExpiredError('jwt expired', new Date());
    });

    const req = createMockReq('Bearer eyJ.expired.token');
    const next = jest.fn() as NextFunction;
    await authMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = (next as jest.Mock).mock.calls[0][0];
    expect(error.message).toBe('Token sudah kadaluarsa');
  });

  it('P5 — membalas "Token tidak valid" generik untuk kegagalan verifikasi LAIN (bukan token expired, mis. signature salah)', async () => {
    jwtVerifyMock.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    const req = createMockReq('Bearer eyJ.forged.token');
    const next = jest.fn() as NextFunction;
    await authMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = (next as jest.Mock).mock.calls[0][0];
    expect(error.message).toBe('Token tidak valid');
  });

  it('P5 — menolak access token yang SUDAH di-blacklist (logout) walau signature-nya masih valid', async () => {
    jwtVerifyMock.mockReturnValue({
      id: 'user-1',
      email: 'budi@example.com',
      role: 'USER',
      jti: 'jti-revoked',
      exp: 9999999999,
    });
    isBlacklistedMock.mockResolvedValue(true);

    const req = createMockReq('Bearer eyJ.valid.butblacklisted');
    const next = jest.fn() as NextFunction;
    await authMiddleware(req, {} as Response, next);

    expect(isBlacklistedMock).toHaveBeenCalledWith('jti-revoked');
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = (next as jest.Mock).mock.calls[0][0];
    expect(error.message).toContain('sudah dicabut');
  });
});
