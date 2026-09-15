import type { Request, Response } from 'express';
import { SsoAdminController, SsoController } from './sso.controller';
import type { SsoConnectionService, SsoService } from './sso.service';
import { NotFoundError } from '../../shared/utils/http-error';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}

function createMockRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

describe('SsoAdminController', () => {
  let ssoConnectionService: jest.Mocked<SsoConnectionService>;
  let controller: SsoAdminController;

  const publicConnection = {
    tenantId: 'tenant-1',
    issuerUrl: 'https://idp.example.com',
    clientId: 'client-abc',
    allowedEmailDomain: 'acme.com',
    enabled: true,
  };

  beforeEach(() => {
    ssoConnectionService = {
      upsert: jest.fn(),
      get: jest.fn(),
    } as unknown as jest.Mocked<SsoConnectionService>;
    controller = new SsoAdminController(ssoConnectionService);
  });

  it('upsert — memvalidasi body & meneruskan ke service, TIDAK PERNAH mengembalikan clientSecret dalam bentuk apa pun', async () => {
    ssoConnectionService.upsert.mockResolvedValue(publicConnection);
    const req = createMockRequest({
      params: { tenantSlug: 'acme' },
      body: {
        issuerUrl: 'https://idp.example.com',
        clientId: 'client-abc',
        clientSecret: 'rahasia-banget',
        allowedEmailDomain: 'acme.com',
      },
    });
    const res = createMockResponse();

    await controller.upsert(req, res);

    expect(ssoConnectionService.upsert).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ clientSecret: 'rahasia-banget' })
    );
    const jsonCall = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonCall.data).toEqual(publicConnection);
    expect(JSON.stringify(jsonCall)).not.toContain('rahasia-banget');
  });

  it('get — melempar NotFoundError kalau tenant belum punya konfigurasi SSO', async () => {
    ssoConnectionService.get.mockResolvedValue(null);
    const req = createMockRequest({ params: { tenantSlug: 'acme' } });
    const res = createMockResponse();

    await expect(controller.get(req, res)).rejects.toThrow(NotFoundError);
  });

  it('get — mengembalikan konfigurasi kalau ada', async () => {
    ssoConnectionService.get.mockResolvedValue(publicConnection);
    const req = createMockRequest({ params: { tenantSlug: 'acme' } });
    const res = createMockResponse();

    await controller.get(req, res);

    expect(res.json).toHaveBeenCalled();
  });
});

describe('SsoController', () => {
  let ssoService: jest.Mocked<SsoService>;
  let controller: SsoController;

  beforeEach(() => {
    ssoService = {
      buildAuthorizationUrl: jest.fn(),
      handleCallback: jest.fn(),
      consume: jest.fn(),
    } as unknown as jest.Mocked<SsoService>;
    controller = new SsoController(ssoService);
  });

  it('login — redirect browser langsung ke authorization URL dari service (bukan JSON)', async () => {
    ssoService.buildAuthorizationUrl.mockResolvedValue('https://idp.example.com/authorize?x=1');
    const req = createMockRequest({ params: { tenantSlug: 'acme' } });
    const res = createMockResponse();

    await controller.login(req, res);

    expect(res.redirect).toHaveBeenCalledWith('https://idp.example.com/authorize?x=1');
  });

  it('callback — redirect ke SSO_FRONTEND_CALLBACK_URL dengan ?code=<kode tukar>, TIDAK PERNAH mengembalikan token langsung di URL', async () => {
    ssoService.handleCallback.mockResolvedValue('exchange-code-xyz');
    const req = createMockRequest({
      params: { tenantSlug: 'acme' },
      query: { code: 'idp-code', state: 'st' },
    });
    const res = createMockResponse();

    await controller.callback(req, res);

    const redirectedUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
    expect(redirectedUrl).toBe('http://localhost:5173/sso/callback?code=exchange-code-xyz');
  });

  it('consume — memvalidasi body & meneruskan code ke service', async () => {
    const authResponse = {
      accessToken: 'a',
      refreshToken: 'b',
      user: { id: 'u1', email: 'x@acme.com', name: 'X', createdAt: new Date() },
    };
    ssoService.consume.mockResolvedValue(authResponse);
    const req = createMockRequest({ body: { code: 'kode-tukar' } });
    const res = createMockResponse();

    await controller.consume(req, res);

    expect(ssoService.consume).toHaveBeenCalledWith('kode-tukar');
    expect(res.json).toHaveBeenCalled();
  });
});
