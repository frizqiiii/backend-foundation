import { Issuer, generators } from 'openid-client';
import { SsoService } from './sso.service';
import type { SsoConnectionRepository, SsoIdentityRepository } from './sso.repository';
import type { TenantRepository } from '../tenants/tenant.repository';
import type { UserRepository } from '../users/user.repository';
import type { AuthService } from './auth.service';
import { redisClient } from '../../shared/config/redis';
import { encryptionService } from '../../shared/security/encryption.service';
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/utils/http-error';

/**
 * `openid-client` di-automock — `Issuer.discover` dikontrol penuh per
 * test (dikembalikan objek dengan `Client` berupa CLASS MOCK manual,
 * bukan hasil automock, supaya `new issuer.Client(...)` menghasilkan
 * instance dengan `authorizationUrl`/`callback` yang bisa
 * diverifikasi) — TIDAK ADA panggilan jaringan sungguhan ke IdP mana
 * pun selama test ini.
 */
jest.mock('openid-client');

// Temuan T16 — `state` dan kode tukar diambil lewat `MULTI GET/DEL EXEC` (atomik), bukan `get` lalu `del`.
const mockTakeChain = {
  get: jest.fn(),
  del: jest.fn(),
  exec: jest.fn(),
};
jest.mock('../../shared/config/redis', () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    multi: jest.fn(() => mockTakeChain),
  },
}));

/** `EXEC` mengembalikan `[[err, hasilGET], [err, hasilDEL]]`; `null` = kunci tidak ada. */
function mockTake(value: string | null): void {
  mockTakeChain.get.mockReturnValue(mockTakeChain);
  mockTakeChain.del.mockReturnValue(mockTakeChain);
  mockTakeChain.exec.mockResolvedValue([
    [null, value],
    [null, value === null ? 0 : 1],
  ]);
}

const MockedIssuer = Issuer as jest.Mocked<typeof Issuer>;
const mockedGenerators = generators as jest.Mocked<typeof generators>;
const mockedRedis = redisClient as unknown as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  multi: jest.Mock;
};

const mockAuthorizationUrl = jest.fn();
const mockCallback = jest.fn();
class MockOidcClient {
  authorizationUrl = mockAuthorizationUrl;
  callback = mockCallback;
}

describe('SsoService', () => {
  let ssoService: SsoService;
  let ssoConnectionRepository: jest.Mocked<SsoConnectionRepository>;
  let ssoIdentityRepository: jest.Mocked<SsoIdentityRepository>;
  let tenantRepository: jest.Mocked<TenantRepository>;
  let userRepository: jest.Mocked<UserRepository>;
  let authService: jest.Mocked<AuthService>;

  const tenant = { id: 'tenant-1', slug: 'acme', name: 'Acme Corp' };
  const connection = {
    tenantId: tenant.id,
    issuerUrl: 'https://idp.example.com',
    clientId: 'client-abc',
    clientSecretEncrypted: encryptionService.encrypt('super-secret'),
    allowedEmailDomain: 'acme.com',
    enabled: true,
  };
  const dbUser = {
    id: 'user-1',
    email: 'budi@acme.com',
    name: 'Budi',
    role: 'USER',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    tenantId: tenant.id,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    ssoConnectionRepository = {
      findByTenantId: jest.fn(),
      upsert: jest.fn(),
    } as unknown as jest.Mocked<SsoConnectionRepository>;

    ssoIdentityRepository = {
      findByTenantAndSubject: jest.fn(),
      create: jest.fn(),
    } as unknown as jest.Mocked<SsoIdentityRepository>;

    tenantRepository = {
      findBySlug: jest.fn(),
      findById: jest.fn(),
    } as unknown as jest.Mocked<TenantRepository>;

    userRepository = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;

    authService = {
      issueTokensForUser: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;

    ssoService = new SsoService(
      ssoConnectionRepository,
      ssoIdentityRepository,
      tenantRepository,
      userRepository,
      authService
    );

    tenantRepository.findBySlug.mockResolvedValue(tenant as never);
    ssoConnectionRepository.findByTenantId.mockResolvedValue(connection as never);
    MockedIssuer.discover.mockResolvedValue({ Client: MockOidcClient } as never);
    // `openid-client` mengimplementasikan `generators.state`/`.nonce`/
    // `.codeVerifier` sebagai REFERENSI FUNGSI YANG SAMA PERSIS (lihat
    // `node_modules/openid-client/lib/helpers/generators.js`:
    // `state: random, nonce: random, codeVerifier: random`) — jest
    // automock karenanya membuat SATU mock function yang dipakai
    // bersama ketiganya, bukan tiga mock terpisah. `mockReturnValueOnce`
    // dirangkai di SATU alias (`.state`) sesuai URUTAN PERSIS
    // `SsoService.buildAuthorizationUrl` memanggilnya (state -> nonce
    // -> codeVerifier) — memanggil salah satu alias lain di runtime
    // tetap mengambil antrian yang sama.
    mockedGenerators.state
      .mockReturnValueOnce('mock-state')
      .mockReturnValueOnce('mock-nonce')
      .mockReturnValueOnce('mock-code-verifier');
    mockedGenerators.codeChallenge.mockReturnValue('mock-code-challenge');
    authService.issueTokensForUser.mockResolvedValue({
      accessToken: 'signed.access.token',
      refreshToken: 'raw-refresh-token',
      user: { id: dbUser.id, email: dbUser.email, name: dbUser.name, createdAt: dbUser.createdAt },
    });
  });

  // ---------------------------------------------------------------
  // buildAuthorizationUrl
  // ---------------------------------------------------------------
  describe('buildAuthorizationUrl', () => {
    it('menolak kalau tenant tidak ditemukan', async () => {
      tenantRepository.findBySlug.mockResolvedValue(null);
      await expect(ssoService.buildAuthorizationUrl('tidak-ada')).rejects.toThrow(NotFoundError);
    });

    it('menolak kalau tenant belum punya konfigurasi SSO', async () => {
      ssoConnectionRepository.findByTenantId.mockResolvedValue(null);
      await expect(ssoService.buildAuthorizationUrl('acme')).rejects.toThrow(BadRequestError);
    });

    it('menolak kalau konfigurasi SSO ada tapi dinonaktifkan (enabled: false)', async () => {
      ssoConnectionRepository.findByTenantId.mockResolvedValue({
        ...connection,
        enabled: false,
      } as never);
      await expect(ssoService.buildAuthorizationUrl('acme')).rejects.toThrow(BadRequestError);
    });

    it('menyimpan state+nonce+codeVerifier ke Redis dengan TTL, lalu mengembalikan authorization URL dari client OIDC', async () => {
      mockAuthorizationUrl.mockReturnValue('https://idp.example.com/authorize?...');

      const url = await ssoService.buildAuthorizationUrl('acme');

      expect(url).toBe('https://idp.example.com/authorize?...');
      expect(mockedRedis.set).toHaveBeenCalledWith(
        'sso:state:mock-state',
        JSON.stringify({
          tenantId: tenant.id,
          nonce: 'mock-nonce',
          codeVerifier: 'mock-code-verifier',
        }),
        'EX',
        300
      );
      expect(mockAuthorizationUrl).toHaveBeenCalledWith({
        scope: 'openid email profile',
        state: 'mock-state',
        nonce: 'mock-nonce',
        code_challenge: 'mock-code-challenge',
        code_challenge_method: 'S256',
      });
    });
  });

  // ---------------------------------------------------------------
  // handleCallback
  // ---------------------------------------------------------------
  describe('handleCallback', () => {
    const validQuery = { code: 'idp-auth-code', state: 'mock-state' };
    const validStatePayload = JSON.stringify({
      tenantId: tenant.id,
      nonce: 'mock-nonce',
      codeVerifier: 'mock-code-verifier',
    });

    it('menolak kalau IdP mengirim parameter error (mis. user membatalkan consent)', async () => {
      await expect(
        ssoService.handleCallback('acme', {
          state: 'x',
          error: 'access_denied',
          error_description: 'User membatalkan',
        })
      ).rejects.toThrow(UnauthorizedError);
      // Tidak boleh sempat membaca Redis sama sekali kalau IdP sudah menolak duluan.
      expect(mockedRedis.multi).not.toHaveBeenCalled();
    });

    it('menolak kalau parameter code tidak ada', async () => {
      await expect(ssoService.handleCallback('acme', { state: 'x' })).rejects.toThrow(
        BadRequestError
      );
    });

    it('menolak kalau state tidak ditemukan di Redis (kedaluwarsa/sudah dipakai/palsu)', async () => {
      mockTake(null);
      await expect(ssoService.handleCallback('acme', validQuery)).rejects.toThrow(
        UnauthorizedError
      );
    });

    it('MENGHAPUS state dari Redis segera setelah dibaca (single-use), sebelum lanjut ke langkah berikutnya', async () => {
      mockTake(validStatePayload);
      mockCallback.mockResolvedValue({
        claims: () => ({ sub: 'sub-1', email: 'budi@acme.com', name: 'Budi' }),
      });
      ssoIdentityRepository.findByTenantAndSubject.mockResolvedValue(null);
      userRepository.findByEmail.mockResolvedValue(null);
      userRepository.create.mockResolvedValue(dbUser as never);

      await ssoService.handleCallback('acme', validQuery);

      expect(mockTakeChain.get).toHaveBeenCalledWith('sso:state:mock-state');
      expect(mockTakeChain.del).toHaveBeenCalledWith('sso:state:mock-state');
      expect(mockTakeChain.exec).toHaveBeenCalledTimes(1);
      // Bukan lagi `get` lalu `del` terpisah (tidak atomik).
      expect(mockedRedis.get).not.toHaveBeenCalled();
      expect(mockedRedis.del).not.toHaveBeenCalled();
    });

    it('menolak kalau state ditemukan tapi tenantId-nya BEDA dari tenant di path callback (mencegah state tenant A dipakai di callback tenant B)', async () => {
      mockTake(JSON.stringify({ tenantId: 'tenant-LAIN', nonce: 'n', codeVerifier: 'v' }));
      await expect(ssoService.handleCallback('acme', validQuery)).rejects.toThrow(
        UnauthorizedError
      );
    });

    it('menolak kalau email dari klaim OIDC BUKAN di domain yang diizinkan tenant ini', async () => {
      mockTake(validStatePayload);
      mockCallback.mockResolvedValue({
        claims: () => ({ sub: 'sub-1', email: 'orang-luar@gmail.com', name: 'Orang Luar' }),
      });

      await expect(ssoService.handleCallback('acme', validQuery)).rejects.toThrow(ForbiddenError);
      expect(userRepository.create).not.toHaveBeenCalled();
    });

    it('menolak kalau email SUDAH terdaftar tapi milik tenant LAIN — SSO tidak boleh menautkan lintas-tenant', async () => {
      mockTake(validStatePayload);
      mockCallback.mockResolvedValue({
        claims: () => ({ sub: 'sub-baru', email: 'budi@acme.com', name: 'Budi' }),
      });
      ssoIdentityRepository.findByTenantAndSubject.mockResolvedValue(null);
      userRepository.findByEmail.mockResolvedValue({
        ...dbUser,
        tenantId: 'tenant-LAIN-SEKALI-LAGI',
      } as never);

      await expect(ssoService.handleCallback('acme', validQuery)).rejects.toThrow(ForbiddenError);
      expect(ssoIdentityRepository.create).not.toHaveBeenCalled();
    });

    it('JIT-provision: membuat User BARU + SsoIdentity kalau belum pernah login lewat SSO ini maupun terdaftar manual', async () => {
      mockTake(validStatePayload);
      mockCallback.mockResolvedValue({
        claims: () => ({ sub: 'sub-baru', email: 'budi@acme.com', name: 'Budi' }),
      });
      ssoIdentityRepository.findByTenantAndSubject.mockResolvedValue(null);
      userRepository.findByEmail.mockResolvedValue(null);
      userRepository.create.mockResolvedValue(dbUser as never);

      const exchangeCode = await ssoService.handleCallback('acme', validQuery);

      expect(userRepository.create).toHaveBeenCalledWith({
        email: 'budi@acme.com',
        name: 'Budi',
        password: null,
        emailVerifiedAt: expect.any(Date),
      });
      expect(ssoIdentityRepository.create).toHaveBeenCalledWith({
        tenantId: tenant.id,
        subject: 'sub-baru',
        userId: dbUser.id,
      });
      expect(authService.issueTokensForUser).toHaveBeenCalledWith(dbUser);
      // Kode tukar disimpan ke Redis dengan TTL pendek (60 detik),
      // BUKAN token langsung — lihat komentar SSO_FRONTEND_CALLBACK_URL.
      expect(mockedRedis.set).toHaveBeenCalledWith(
        `sso:exchange:${exchangeCode}`,
        JSON.stringify({
          accessToken: 'signed.access.token',
          refreshToken: 'raw-refresh-token',
          user: {
            id: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            createdAt: dbUser.createdAt,
          },
        }),
        'EX',
        60
      );
    });

    it('login SSO berikutnya (SsoIdentity sudah ada): TIDAK membuat User baru, langsung pakai user yang sudah tertaut', async () => {
      mockTake(validStatePayload);
      mockCallback.mockResolvedValue({
        claims: () => ({ sub: 'sub-lama', email: 'budi@acme.com', name: 'Budi' }),
      });
      ssoIdentityRepository.findByTenantAndSubject.mockResolvedValue({
        id: 'identity-1',
        tenantId: tenant.id,
        subject: 'sub-lama',
        userId: dbUser.id,
        createdAt: new Date(),
      } as never);
      userRepository.findById.mockResolvedValue(dbUser as never);

      await ssoService.handleCallback('acme', validQuery);

      expect(userRepository.create).not.toHaveBeenCalled();
      expect(ssoIdentityRepository.create).not.toHaveBeenCalled();
      expect(authService.issueTokensForUser).toHaveBeenCalledWith(dbUser);
    });
  });

  // ---------------------------------------------------------------
  // consume
  // ---------------------------------------------------------------
  describe('consume', () => {
    it('menolak kode yang tidak ditemukan di Redis (invalid/sudah dipakai/kedaluwarsa)', async () => {
      mockTake(null);
      await expect(ssoService.consume('kode-acak')).rejects.toThrow(UnauthorizedError);
    });

    it('mengembalikan AuthResponseDto dari Redis lalu MENGHAPUS kodenya (single-use)', async () => {
      const stored = {
        accessToken: 'a',
        refreshToken: 'b',
        user: { id: 'u1', email: 'x@acme.com', name: 'X', createdAt: new Date().toISOString() },
      };
      mockTake(JSON.stringify(stored));

      const result = await ssoService.consume('kode-valid');

      expect(result).toEqual(stored);
      expect(mockTakeChain.get).toHaveBeenCalledWith('sso:exchange:kode-valid');
      expect(mockTakeChain.del).toHaveBeenCalledWith('sso:exchange:kode-valid');
      expect(mockedRedis.del).not.toHaveBeenCalled();
    });

    describe('temuan T16 — single-use tetap berlaku di bawah permintaan BERSAMAAN', () => {
      /**
       * Redis tiruan yang meniru sifat yang relevan: setiap perintah terpisah (`get`, `del`) membutuhkan satu
       * putaran event-loop, sehingga permintaan bersamaan saling menyisip di antara `get` dan `del`
       * (persis yang terjadi ke Redis sungguhan); sedangkan `MULTI/EXEC` dieksekusi utuh tanpa disisipi.
       * Modelnya dicocokkan dengan Redis 7 sungguhan: pola `get` lalu `del` menghasilkan 20 dari 20 penerima.
       */
      function installInterleavingRedis(initial: Record<string, string>): void {
        const store = new Map(Object.entries(initial));
        const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
        mockedRedis.get.mockImplementation(async (key: string) => {
          await tick();
          return store.get(key) ?? null;
        });
        mockedRedis.del.mockImplementation(async (key: string) => {
          await tick();
          return store.delete(key) ? 1 : 0;
        });
        mockedRedis.multi.mockImplementation(() => {
          const ops: string[] = [];
          const chain = {
            get: (key: string) => {
              ops.push(key);
              return chain;
            },
            del: () => chain,
            exec: async () => {
              await tick();
              const key = ops[0];
              const value = store.get(key) ?? null;
              store.delete(key);
              return [
                [null, value],
                [null, value === null ? 0 : 1],
              ];
            },
          };
          return chain;
        });
      }

      it.each([2, 5, 20])(
        '%i consume() bersamaan untuk SATU kode: TEPAT satu yang menerima token, sisanya ditolak',
        async (concurrency) => {
          const stored = { accessToken: 'a', refreshToken: 'b', user: { id: 'u1' } };
          installInterleavingRedis({ 'sso:exchange:kode-bersama': JSON.stringify(stored) });

          const results = await Promise.allSettled(
            Array.from({ length: concurrency }, () => ssoService.consume('kode-bersama'))
          );

          const fulfilled = results.filter((r) => r.status === 'fulfilled');
          const rejected = results.filter((r) => r.status === 'rejected');
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(concurrency - 1);
          for (const r of rejected) {
            expect((r as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedError);
          }
        }
      );
    });
  });
});
