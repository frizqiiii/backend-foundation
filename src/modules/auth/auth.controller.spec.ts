import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { OAuthService } from './oauth.service';
import type { AuditService } from '../audit/audit.service';
import type { ActivityService } from '../activity/activity.service';
import { UnauthorizedError } from '../../shared/utils/http-error';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createMockRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    ip: '10.0.0.1',
    get: jest.fn().mockReturnValue('curl/8.0'),
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

const authUser = { id: 'user-1', email: 'budi@example.com', name: 'Budi', createdAt: new Date() };

describe('AuthController', () => {
  let authService: jest.Mocked<AuthService>;
  let oauthService: jest.Mocked<OAuthService>;
  let auditService: jest.Mocked<AuditService>;
  let activityService: jest.Mocked<ActivityService>;
  let controller: AuthController;

  beforeEach(() => {
    authService = {
      register: jest.fn(),
      login: jest.fn(),
      verifyMfaLogin: jest.fn(),
      refresh: jest.fn(),
      logout: jest.fn(),
      listSessions: jest.fn(),
      revokeSession: jest.fn(),
      revokeAllSessions: jest.fn(),
      verifyEmail: jest.fn(),
      forgotPassword: jest.fn(),
      resetPassword: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;
    oauthService = {
      loginWithGoogle: jest.fn(),
      loginWithGithub: jest.fn(),
    } as unknown as jest.Mocked<OAuthService>;
    auditService = {
      logLogin: jest.fn(),
      logLogout: jest.fn(),
      logSessionRevoked: jest.fn(),
      logAllSessionsRevoked: jest.fn(),
      getLoginHistory: jest.fn(),
    } as unknown as jest.Mocked<AuditService>;
    activityService = { logAuthActivity: jest.fn() } as unknown as jest.Mocked<ActivityService>;
    controller = new AuthController(authService, oauthService, auditService, activityService);
  });

  describe('register', () => {
    it('mendaftarkan user, membalas 201', async () => {
      const req = createMockRequest({
        body: { name: 'Budi', email: 'budi@example.com', password: 'Password123' },
      });
      const res = createMockResponse();
      authService.register.mockResolvedValue(authUser as never);

      await controller.register(req, res);

      expect(authService.register).toHaveBeenCalledWith({
        name: 'Budi',
        email: 'budi@example.com',
        password: 'Password123',
      });
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('login', () => {
    it('login sukses TANPA MFA: mencatat audit+activity LOGIN, membalas 200', async () => {
      const req = createMockRequest({ body: { email: 'budi@example.com', password: 'x' } });
      const res = createMockResponse();
      const result = { accessToken: 'a', refreshToken: 'r', user: authUser };
      authService.login.mockResolvedValue(result as never);

      await controller.login(req, res);

      expect(authService.login).toHaveBeenCalledWith(
        { email: 'budi@example.com', password: 'x' },
        { ipAddress: '10.0.0.1', userAgent: 'curl/8.0' }
      );
      expect(auditService.logLogin).toHaveBeenCalledWith({
        userId: 'user-1',
        ipAddress: '10.0.0.1',
        userAgent: 'curl/8.0',
      });
      expect(activityService.logAuthActivity).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: result }));
    });

    it('P5 — MFA diperlukan: TIDAK mencatat audit/activity LOGIN sama sekali (login belum benar-benar selesai)', async () => {
      const req = createMockRequest({ body: { email: 'budi@example.com', password: 'x' } });
      const res = createMockResponse();
      const mfaResult = { mfaRequired: true, challengeToken: 'challenge-abc' };
      authService.login.mockResolvedValue(mfaResult as never);

      await controller.login(req, res);

      expect(auditService.logLogin).not.toHaveBeenCalled();
      expect(activityService.logAuthActivity).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: mfaResult }));
    });
  });

  describe('verifyMfaLogin', () => {
    it('menyelesaikan login MFA, mencatat audit+activity LOGIN di titik INI (bukan di login())', async () => {
      const req = createMockRequest({ body: { challengeToken: 'c', code: '123456' } });
      const res = createMockResponse();
      const result = { accessToken: 'a', refreshToken: 'r', user: authUser };
      authService.verifyMfaLogin.mockResolvedValue(result as never);

      await controller.verifyMfaLogin(req, res);

      expect(authService.verifyMfaLogin).toHaveBeenCalledWith(
        { challengeToken: 'c', code: '123456' },
        { ipAddress: '10.0.0.1', userAgent: 'curl/8.0' }
      );
      expect(auditService.logLogin).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' })
      );
      expect(activityService.logAuthActivity).toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('memperbarui token, TIDAK mencatat audit/activity apa pun (bukan event login/logout)', async () => {
      const req = createMockRequest({ body: { refreshToken: 'r' } });
      const res = createMockResponse();
      const result = { accessToken: 'a2', refreshToken: 'r2' };
      authService.refresh.mockResolvedValue(result as never);

      await controller.refresh(req, res);

      expect(authService.refresh).toHaveBeenCalledWith(
        { refreshToken: 'r' },
        { ipAddress: '10.0.0.1', userAgent: 'curl/8.0' }
      );
      expect(auditService.logLogin).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: result }));
    });
  });

  describe('logout', () => {
    it('memakai jti/exp dari req.user (hasil decode access token) + refreshToken dari body, mencatat audit+activity LOGOUT', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', jti: 'jti-abc', exp: 1234567890 },
        body: { refreshToken: 'r' },
      });
      const res = createMockResponse();

      await controller.logout(req, res);

      expect(authService.logout).toHaveBeenCalledWith('user-1', 'jti-abc', 1234567890, 'r');
      expect(auditService.logLogout).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' })
      );
      expect(activityService.logAuthActivity).toHaveBeenCalledWith(
        'User logout',
        expect.objectContaining({ userId: 'user-1' })
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ body: { refreshToken: 'r' } });
      const res = createMockResponse();

      await expect(controller.logout(req, res)).rejects.toThrow(UnauthorizedError);
      expect(authService.logout).not.toHaveBeenCalled();
    });
  });

  describe('listSessions', () => {
    it('meneruskan currentRefreshToken dari query string kalau berupa string', async () => {
      const req = createMockRequest({
        user: { id: 'user-1' },
        query: { currentRefreshToken: 'current-rt' },
      });
      const res = createMockResponse();
      authService.listSessions.mockResolvedValue([] as never);

      await controller.listSessions(req, res);

      expect(authService.listSessions).toHaveBeenCalledWith('user-1', 'current-rt');
    });

    it('P5 — meneruskan undefined kalau query currentRefreshToken tidak ada atau bukan string', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, query: {} });
      const res = createMockResponse();
      authService.listSessions.mockResolvedValue([] as never);

      await controller.listSessions(req, res);

      expect(authService.listSessions).toHaveBeenCalledWith('user-1', undefined);
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await expect(controller.listSessions(req, res)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('revokeSession', () => {
    it('mencabut satu sesi, mencatat audit logSessionRevoked dengan id sesi', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, params: { id: 'session-1' } });
      const res = createMockResponse();

      await controller.revokeSession(req, res);

      expect(authService.revokeSession).toHaveBeenCalledWith('user-1', 'session-1');
      expect(auditService.logSessionRevoked).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ userId: 'user-1' })
      );
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ params: { id: 'session-1' } });
      const res = createMockResponse();

      await expect(controller.revokeSession(req, res)).rejects.toThrow(UnauthorizedError);
      expect(authService.revokeSession).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllSessions', () => {
    it('mencabut SELURUH sesi, mencatat audit logAllSessionsRevoked', async () => {
      const req = createMockRequest({ user: { id: 'user-1' } });
      const res = createMockResponse();

      await controller.revokeAllSessions(req, res);

      expect(authService.revokeAllSessions).toHaveBeenCalledWith('user-1');
      expect(auditService.logAllSessionsRevoked).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' })
      );
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await expect(controller.revokeAllSessions(req, res)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('loginHistory', () => {
    it('mengambil riwayat login MILIK SENDIRI (req.user.id)', async () => {
      const req = createMockRequest({ user: { id: 'user-1' }, query: { page: '1', limit: '20' } });
      const res = createMockResponse();
      const result = { data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } };
      auditService.getLoginHistory.mockResolvedValue(result as never);

      await controller.loginHistory(req, res);

      expect(auditService.getLoginHistory).toHaveBeenCalledWith('user-1', { page: 1, limit: 20 });
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await expect(controller.loginHistory(req, res)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('loginHistoryForUser', () => {
    it('P5 — versi admin: mengambil riwayat login dari req.params.id (user LAIN), TIDAK butuh req.user sama sekali di Controller (otorisasi permission ditegakkan di routing)', async () => {
      const req = createMockRequest({ params: { id: 'other-user' }, query: {} });
      const res = createMockResponse();
      const result = { data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } };
      auditService.getLoginHistory.mockResolvedValue(result as never);

      await controller.loginHistoryForUser(req, res);

      expect(auditService.getLoginHistory).toHaveBeenCalledWith('other-user', {
        page: 1,
        limit: 20,
      });
    });
  });

  describe('verifyEmail', () => {
    it('memverifikasi email dari token, membalas 200 data null', async () => {
      const req = createMockRequest({ body: { token: 'verify-token' } });
      const res = createMockResponse();

      await controller.verifyEmail(req, res);

      expect(authService.verifyEmail).toHaveBeenCalledWith({ token: 'verify-token' });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
    });
  });

  describe('forgotPassword', () => {
    it('P5 — selalu membalas 200 generik TERLEPAS dari apakah email terdaftar (anti user-enumeration, diverifikasi lewat perilaku Controller memanggil Service tanpa memeriksa hasilnya)', async () => {
      const req = createMockRequest({ body: { email: 'budi@example.com' } });
      const res = createMockResponse();
      authService.forgotPassword.mockResolvedValue(undefined as never);

      await controller.forgotPassword(req, res);

      expect(authService.forgotPassword).toHaveBeenCalledWith({ email: 'budi@example.com' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Jika email terdaftar'),
        })
      );
    });
  });

  describe('resetPassword', () => {
    it('mereset password dari token, membalas 200', async () => {
      const req = createMockRequest({ body: { token: 't', newPassword: 'PasswordBaru123' } });
      const res = createMockResponse();

      await controller.resetPassword(req, res);

      expect(authService.resetPassword).toHaveBeenCalledWith({
        token: 't',
        newPassword: 'PasswordBaru123',
      });
    });
  });

  describe('loginWithGoogle', () => {
    it('meneruskan idToken ke OAuthService (bukan AuthService)', async () => {
      const req = createMockRequest({ body: { idToken: 'google-id-token' } });
      const res = createMockResponse();
      const result = { accessToken: 'a', refreshToken: 'r', user: authUser };
      oauthService.loginWithGoogle.mockResolvedValue(result as never);

      await controller.loginWithGoogle(req, res);

      expect(oauthService.loginWithGoogle).toHaveBeenCalledWith('google-id-token');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: result }));
    });
  });

  describe('loginWithGithub', () => {
    it('meneruskan code ke OAuthService (bukan AuthService)', async () => {
      const req = createMockRequest({ body: { code: 'github-code' } });
      const res = createMockResponse();
      const result = { accessToken: 'a', refreshToken: 'r', user: authUser };
      oauthService.loginWithGithub.mockResolvedValue(result as never);

      await controller.loginWithGithub(req, res);

      expect(oauthService.loginWithGithub).toHaveBeenCalledWith('github-code');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: result }));
    });
  });
});
