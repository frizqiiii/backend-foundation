import { OAuth2Client } from 'google-auth-library';
import { OAuthService } from './oauth.service';
import type { UserRepository } from '../users/user.repository';
import type { AuthRepository } from './auth.repository';
import type { AuthService } from './auth.service';
import { UnauthorizedError } from '../../shared/utils/http-error';

/**
 * `google-auth-library` di-automock — `OAuth2Client` jadi kelas mock
 * standar Jest (constructor + method di prototype semuanya
 * `jest.fn()`), sehingga `verifyIdToken` bisa dikontrol penuh tanpa
 * pernah benar-benar menghubungi server Google.
 *
 * `fetch` global (dipakai untuk alur GitHub) di-mock manual per test —
 * TIDAK ada panggilan jaringan sungguhan ke GitHub selama test.
 */
jest.mock('google-auth-library');

const MockedOAuth2Client = OAuth2Client as jest.MockedClass<typeof OAuth2Client>;

describe('OAuthService', () => {
  let oauthService: OAuthService;
  let userRepository: jest.Mocked<UserRepository>;
  let authRepository: jest.Mocked<AuthRepository>;
  let authService: jest.Mocked<AuthService>;
  let mockVerifyIdToken: jest.Mock;
  let mockFetch: jest.Mock;

  const dbUser = {
    id: 'user-123',
    email: 'budi@example.com',
    password: null,
    name: 'Budi Santoso',
    role: 'USER',
    emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    tenantId: null,
    mfaEnabled: false,
    mfaSecret: null,
    mfaEnabledAt: null,
  };

  beforeEach(() => {
    userRepository = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;

    authRepository = {
      findOAuthAccount: jest.fn(),
      createOAuthAccount: jest.fn(),
    } as unknown as jest.Mocked<AuthRepository>;

    authService = {
      issueTokensForUser: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;

    mockVerifyIdToken = jest.fn();
    MockedOAuth2Client.prototype.verifyIdToken = mockVerifyIdToken;

    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    oauthService = new OAuthService(userRepository, authRepository, authService);

    authService.issueTokensForUser.mockResolvedValue({
      accessToken: 'signed.access.token',
      refreshToken: 'raw-refresh-token',
      user: { id: dbUser.id, email: dbUser.email, name: dbUser.name, createdAt: dbUser.createdAt },
    });
  });

  // ---------------------------------------------------------------
  // GOOGLE
  // ---------------------------------------------------------------
  describe('loginWithGoogle', () => {
    it('berhasil login dengan akun Google yang SUDAH pernah dipakai sebelumnya', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({ sub: 'google-sub-123', email: dbUser.email, name: dbUser.name }),
      });
      authRepository.findOAuthAccount.mockResolvedValue({
        id: 'oa-1',
        provider: 'GOOGLE',
        providerAccountId: 'google-sub-123',
        userId: dbUser.id,
        createdAt: new Date(),
      } as never);
      userRepository.findById.mockResolvedValue(dbUser as never);

      await oauthService.loginWithGoogle('some-id-token');

      expect(authRepository.createOAuthAccount).not.toHaveBeenCalled();
      expect(authService.issueTokensForUser).toHaveBeenCalledWith(dbUser);
    });

    it('menautkan (link) akun Google ke User yang SUDAH ADA berdasarkan email yang sama', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({ sub: 'google-sub-new', email: dbUser.email, name: dbUser.name }),
      });
      authRepository.findOAuthAccount.mockResolvedValue(null);
      userRepository.findByEmail.mockResolvedValue(dbUser as never);

      await oauthService.loginWithGoogle('some-id-token');

      expect(userRepository.create).not.toHaveBeenCalled();
      expect(authRepository.createOAuthAccount).toHaveBeenCalledWith({
        provider: 'GOOGLE',
        providerAccountId: 'google-sub-new',
        userId: dbUser.id,
      });
      expect(authService.issueTokensForUser).toHaveBeenCalledWith(dbUser);
    });

    it('membuat User BARU tanpa password ketika belum ada akun/email yang cocok sama sekali', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-sub-fresh',
          email: 'baru@example.com',
          name: 'User Baru',
        }),
      });
      authRepository.findOAuthAccount.mockResolvedValue(null);
      userRepository.findByEmail.mockResolvedValue(null);
      const newUser = { ...dbUser, id: 'user-456', email: 'baru@example.com', name: 'User Baru' };
      userRepository.create.mockResolvedValue(newUser as never);

      await oauthService.loginWithGoogle('some-id-token');

      expect(userRepository.create).toHaveBeenCalledWith({
        email: 'baru@example.com',
        name: 'User Baru',
        password: null,
        emailVerifiedAt: expect.any(Date),
      });
      expect(authRepository.createOAuthAccount).toHaveBeenCalledWith({
        provider: 'GOOGLE',
        providerAccountId: 'google-sub-fresh',
        userId: 'user-456',
      });
    });

    it('melempar UnauthorizedError ketika idToken tidak valid', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('invalid token'));

      await expect(oauthService.loginWithGoogle('bad-token')).rejects.toThrow(UnauthorizedError);
    });

    it('melempar BadRequestError ketika GOOGLE_CLIENT_ID tidak dikonfigurasi', async () => {
      const originalClientId = process.env.GOOGLE_CLIENT_ID;
      process.env.GOOGLE_CLIENT_ID = '';

      // `jest.isolateModules` dipakai (bukan `jest.resetModules` biasa)
      // supaya `OAuthService` DAN `BadRequestError` yang dibandingkan
      // sama-sama berasal dari registry modul yang sama persis —
      // kalau tidak, `instanceof`/`toThrow` bisa gagal walau
      // perilakunya sebenarnya benar, karena keduanya jadi referensi
      // class yang berbeda meski bentuknya identik.
      let caughtError: unknown;
      await jest.isolateModulesAsync(async () => {
        /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
        const oauthModule = require('./oauth.service') as typeof import('./oauth.service');
        const errorModule =
          require('../../shared/utils/http-error') as typeof import('../../shared/utils/http-error');
        /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
        const unconfiguredService = new oauthModule.OAuthService(
          userRepository,
          authRepository,
          authService
        );

        try {
          await unconfiguredService.loginWithGoogle('any-token');
        } catch (error) {
          caughtError = error;
        }

        expect(caughtError).toBeInstanceOf(errorModule.BadRequestError);
      });

      process.env.GOOGLE_CLIENT_ID = originalClientId;
    });
  });

  // ---------------------------------------------------------------
  // GITHUB
  // ---------------------------------------------------------------
  describe('loginWithGithub', () => {
    function mockGithubExchangeSuccess(
      githubUser: Partial<{
        id: number;
        name: string | null;
        login: string;
        email: string | null;
      }> = {}
    ) {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'gh-access-token' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 999,
            name: 'Budi GitHub',
            login: 'budigh',
            email: 'budi@example.com',
            ...githubUser,
          }),
        } as Response);
    }

    it('berhasil login: tukar code -> access_token -> profil, lalu terbitkan token aplikasi', async () => {
      mockGithubExchangeSuccess();
      authRepository.findOAuthAccount.mockResolvedValue(null);
      userRepository.findByEmail.mockResolvedValue(dbUser as never);

      await oauthService.loginWithGithub('some-code');

      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://github.com/login/oauth/access_token',
        expect.objectContaining({ method: 'POST' })
      );
      expect(authRepository.createOAuthAccount).toHaveBeenCalledWith({
        provider: 'GITHUB',
        providerAccountId: '999',
        userId: dbUser.id,
      });
      expect(authService.issueTokensForUser).toHaveBeenCalledWith(dbUser);
    });

    it('mengambil email dari /user/emails ketika email profil utama null (private)', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'gh-access-token' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 999, name: 'Budi GitHub', login: 'budigh', email: null }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ email: 'budi@example.com', primary: true, verified: true }],
        } as Response);
      authRepository.findOAuthAccount.mockResolvedValue(null);
      userRepository.findByEmail.mockResolvedValue(dbUser as never);

      await oauthService.loginWithGithub('some-code');

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(userRepository.findByEmail).toHaveBeenCalledWith('budi@example.com');
    });

    it('melempar UnauthorizedError ketika penukaran code gagal (tidak ada access_token)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: 'bad_verification_code',
          error_description: 'Code sudah dipakai',
        }),
      } as Response);

      await expect(oauthService.loginWithGithub('used-code')).rejects.toThrow(UnauthorizedError);
    });

    it('melempar BadRequestError ketika GITHUB_CLIENT_ID/SECRET tidak dikonfigurasi', async () => {
      const originalId = process.env.GITHUB_CLIENT_ID;
      const originalSecret = process.env.GITHUB_CLIENT_SECRET;
      process.env.GITHUB_CLIENT_ID = '';
      process.env.GITHUB_CLIENT_SECRET = '';

      let caughtError: unknown;
      await jest.isolateModulesAsync(async () => {
        /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
        const oauthModule = require('./oauth.service') as typeof import('./oauth.service');
        const errorModule =
          require('../../shared/utils/http-error') as typeof import('../../shared/utils/http-error');
        /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
        const unconfiguredService = new oauthModule.OAuthService(
          userRepository,
          authRepository,
          authService
        );

        try {
          await unconfiguredService.loginWithGithub('any-code');
        } catch (error) {
          caughtError = error;
        }

        expect(caughtError).toBeInstanceOf(errorModule.BadRequestError);
      });

      process.env.GITHUB_CLIENT_ID = originalId;
      process.env.GITHUB_CLIENT_SECRET = originalSecret;
    });
  });
});
