import bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import type { UserRepository } from '../users/user.repository';
import type { AuthRepository } from './auth.repository';
import type { AuditService } from '../audit/audit.service';
import type { MfaService } from './mfa.service';
import type { RoleName } from '../../shared/types/role';
import {
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  TooManyRequestsError,
  NotFoundError,
} from '../../shared/utils/http-error';
import { jwtHelper } from '../../shared/utils/jwt';
import { generateRefreshToken, hashRefreshToken } from '../../shared/utils/refresh-token';
import { generateSecureToken, hashSecureToken } from '../../shared/utils/secure-token';
import { tokenBlacklist } from '../../shared/utils/token-blacklist';
import { enqueueEmailJob } from '../../shared/queue/email.queue';
import {
  checkAccountLock,
  recordFailedAttempt,
  resetAttempts,
} from '../../shared/security/login-attempt-tracker';

/**
 * `bcrypt`, `jwtHelper`, dan seluruh helper token/mailer di-mock di
 * level module (dipakai langsung oleh AuthService, bukan lewat
 * constructor injection) — pola yang sama seperti fase sebelumnya.
 * Semua lewat factory eksplisit (bukan `jest.mock(path)` otomatis)
 * supaya bentuk mock terlihat jelas dan tidak bergantung urutan
 * file lain di-load.
 *
 * `login-attempt-tracker` (Phase 6) DIMOCK juga — modulnya punya
 * state in-memory (Map) yang bertahan ANTAR test dalam file yang
 * sama (`clearMocks` di jest.config.ts hanya mereset mock jest, tidak
 * mereset Map biasa). Tanpa mock ini, beberapa test "password salah"
 * berturut-turut di describe block yang sama bisa TANPA SENGAJA
 * mengunci akun sungguhan dan membuat test lain gagal secara flaky.
 */
jest.mock('bcrypt');
jest.mock('../../shared/utils/jwt', () => ({
  jwtHelper: {
    sign: jest.fn(),
    verify: jest.fn(),
    signMfaChallenge: jest.fn(),
    verifyMfaChallenge: jest.fn(),
  },
}));
jest.mock('../../shared/utils/refresh-token');
jest.mock('../../shared/utils/secure-token');
jest.mock('../../shared/utils/token-blacklist', () => ({
  tokenBlacklist: { add: jest.fn(), isBlacklisted: jest.fn() },
}));
jest.mock('../../shared/queue/email.queue', () => ({
  enqueueEmailJob: jest.fn(),
}));
jest.mock('../../shared/security/login-attempt-tracker', () => ({
  checkAccountLock: jest.fn(),
  recordFailedAttempt: jest.fn(),
  resetAttempts: jest.fn(),
}));

const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;
const mockedJwtHelper = jwtHelper as jest.Mocked<typeof jwtHelper>;
const mockedGenerateRefreshToken = generateRefreshToken as jest.Mock;
const mockedHashRefreshToken = hashRefreshToken as jest.Mock;
const mockedGenerateSecureToken = generateSecureToken as jest.Mock;
const mockedHashSecureToken = hashSecureToken as jest.Mock;
const mockedTokenBlacklist = tokenBlacklist as jest.Mocked<typeof tokenBlacklist>;
const mockedEnqueueEmailJob = enqueueEmailJob as jest.Mock;
const mockedCheckAccountLock = checkAccountLock as jest.Mock;
const mockedRecordFailedAttempt = recordFailedAttempt as jest.Mock;
const mockedResetAttempts = resetAttempts as jest.Mock;

describe('AuthService', () => {
  let authService: AuthService;
  let userRepository: jest.Mocked<UserRepository>;
  let authRepository: jest.Mocked<AuthRepository>;
  let auditService: jest.Mocked<AuditService>;
  let mfaService: jest.Mocked<MfaService>;

  const dbUser = {
    id: 'user-123',
    email: 'budi@example.com',
    password: 'hashed-password-from-db',
    name: 'Budi Santoso',
    role: 'USER' as unknown as RoleName,
    emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'), // terverifikasi secara default
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    erasedAt: null,
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
      createRefreshToken: jest.fn(),
      findRefreshTokenByHash: jest.fn(),
      findRefreshTokenById: jest.fn(),
      findActiveSessionsForUser: jest.fn(),
      revokeRefreshToken: jest.fn(),
      revokeRefreshTokenIfActive: jest.fn(),
      revokeAllRefreshTokensForUser: jest.fn(),
      revokeRefreshTokenFamily: jest.fn(),
      createEmailVerificationToken: jest.fn(),
      findEmailVerificationTokenByHash: jest.fn(),
      deleteEmailVerificationToken: jest.fn(),
      createPasswordResetToken: jest.fn(),
      findPasswordResetTokenByHash: jest.fn(),
      deletePasswordResetToken: jest.fn(),
      deleteAllPasswordResetTokensForUser: jest.fn(),
      // Default: user dianggap SUDAH punya riwayat login (bukan
      // login pertama) tapi device saat ini "dikenal" — kombinasi ini
      // dipilih sebagai default paling NETRAL (isNewDeviceForExistingUser
      // mengembalikan `false`), supaya test login yang tidak secara
      // eksplisit menguji suspicious-login tidak tiba-tiba memicu efek
      // samping (audit log + email) yang tidak mereka duga.
      countRefreshTokensForUser: jest.fn().mockResolvedValue(1),
      hasKnownDevice: jest.fn().mockResolvedValue(true),
      // Mock `runInTransaction` (Phase 8) langsung MENJALANKAN
      // callback-nya dengan `tx` berupa `undefined` — unit test tidak
      // butuh transaksi database sungguhan, hanya perlu memastikan
      // seluruh operasi di dalam callback tetap terpanggil seolah
      // berjalan normal.
      runInTransaction: jest.fn((fn: (tx: undefined) => Promise<unknown>) => fn(undefined)),
    } as unknown as jest.Mocked<AuthRepository>;

    auditService = {
      logCreate: jest.fn(),
      logUpdate: jest.fn(),
      logDelete: jest.fn(),
      logLogin: jest.fn(),
      logLogout: jest.fn(),
      logLoginFailed: jest.fn(),
      logSessionRevoked: jest.fn(),
      logAllSessionsRevoked: jest.fn(),
      logSuspiciousLogin: jest.fn(),
      getLoginHistory: jest.fn(),
    } as unknown as jest.Mocked<AuditService>;

    // Phase 12 — dbUser di fixture ini punya `mfaEnabled: false`
    // secara default, jadi jalur MFA tidak pernah ditempuh di
    // sebagian besar test yang sudah ada; `verifyCode` tetap
    // di-mock supaya test khusus MFA di bawah bisa mengatur
    // perilakunya sendiri.
    mfaService = {
      beginSetup: jest.fn(),
      confirmSetup: jest.fn(),
      disable: jest.fn(),
      verifyCode: jest.fn(),
    } as unknown as jest.Mocked<MfaService>;

    authService = new AuthService(userRepository, authRepository, auditService, mfaService);

    // Default deterministik untuk helper hash — memetakan token mentah
    // ke string "hash-of-<token>" alih-alih hash SHA-256 sungguhan,
    // supaya assertion mudah dibaca tanpa mengorbankan korespondensi
    // satu-ke-satu antar token.
    mockedHashRefreshToken.mockImplementation((token: string) => `hash-of-${token}`);
    mockedHashSecureToken.mockImplementation((token: string) => `hash-of-${token}`);
    mockedGenerateSecureToken.mockReturnValue('raw-secure-token');
    // Default: akun TIDAK terkunci — test yang spesifik menguji
    // brute-force protection akan meng-override ini sendiri.
    mockedCheckAccountLock.mockResolvedValue({ locked: false });
  });

  // ---------------------------------------------------------------
  // REGISTER
  // ---------------------------------------------------------------
  describe('register', () => {
    const registerInput = {
      name: 'Budi Santoso',
      email: 'budi@example.com',
      password: 'plainPassword123',
    };

    it('berhasil mendaftarkan user baru DAN menerbitkan+mengirim token verifikasi email', async () => {
      userRepository.findByEmail.mockResolvedValue(null);
      mockedBcrypt.hash.mockResolvedValue('hashed-password-from-db' as never);
      userRepository.create.mockResolvedValue(dbUser);
      authRepository.createEmailVerificationToken.mockResolvedValue({} as never);

      const result = await authService.register(registerInput);

      expect(userRepository.create).toHaveBeenCalledWith({
        email: registerInput.email,
        password: 'hashed-password-from-db',
        name: registerInput.name,
      });
      expect(authRepository.createEmailVerificationToken).toHaveBeenCalledWith({
        tokenHash: 'hash-of-raw-secure-token',
        userId: dbUser.id,
        expiresAt: expect.any(Date),
      });
      expect(mockedEnqueueEmailJob).toHaveBeenCalledWith({
        type: 'verification',
        to: dbUser.email,
        token: 'raw-secure-token',
      });
      expect(result).not.toHaveProperty('password');
    });

    it('melempar ConflictError ketika email sudah terdaftar', async () => {
      userRepository.findByEmail.mockResolvedValue(dbUser);

      await expect(authService.register(registerInput)).rejects.toThrow(ConflictError);
      expect(userRepository.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // LOGIN
  // ---------------------------------------------------------------
  describe('login', () => {
    const loginInput = { email: 'budi@example.com', password: 'plainPassword123' };

    it('berhasil login dan menerbitkan accessToken + refreshToken ketika email sudah terverifikasi', async () => {
      userRepository.findByEmail.mockResolvedValue(dbUser);
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedJwtHelper.sign.mockReturnValue('signed.access.token');
      mockedGenerateRefreshToken.mockReturnValue('raw-refresh-token');
      authRepository.createRefreshToken.mockResolvedValue({} as never);

      const result = await authService.login(loginInput);

      // Login sukses HARUS mereset hitungan percobaan gagal — kalau
      // tidak, kegagalan lama yang belum sampai mengunci akun akan
      // ikut terhitung ke sesi login berikutnya yang justru sah.
      expect(mockedResetAttempts).toHaveBeenCalledWith(loginInput.email);

      expect(mockedJwtHelper.sign).toHaveBeenCalledWith({
        id: dbUser.id,
        email: dbUser.email,
        role: dbUser.role,
      });
      // Yang disimpan ke database HARUS hash-nya, bukan token mentah.
      expect(authRepository.createRefreshToken).toHaveBeenCalledWith({
        tokenHash: 'hash-of-raw-refresh-token',
        userId: dbUser.id,
        expiresAt: expect.any(Date),
        familyId: expect.any(String),
        familySessionExpiresAt: expect.any(Date),
        userAgent: null,
        ipAddress: null,
      });
      expect(result).toEqual({
        accessToken: 'signed.access.token',
        refreshToken: 'raw-refresh-token',
        user: {
          id: dbUser.id,
          email: dbUser.email,
          name: dbUser.name,
          createdAt: dbUser.createdAt,
        },
      });
    });

    it('menyimpan userAgent & ipAddress requester ke refresh token yang diterbitkan (Phase 7 device tracking)', async () => {
      userRepository.findByEmail.mockResolvedValue(dbUser);
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedGenerateRefreshToken.mockReturnValue('raw-refresh-token');
      authRepository.createRefreshToken.mockResolvedValue({} as never);

      await authService.login(loginInput, { userAgent: 'Mozilla/5.0', ipAddress: '203.0.113.7' });

      expect(authRepository.createRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: 'Mozilla/5.0', ipAddress: '203.0.113.7' })
      );
    });

    it('melempar ForbiddenError ketika email BELUM diverifikasi, DAN mencatatnya sebagai percobaan gagal (kredensial benar, akun belum siap)', async () => {
      userRepository.findByEmail.mockResolvedValue({ ...dbUser, emailVerifiedAt: null });
      mockedBcrypt.compare.mockResolvedValue(true as never);

      await expect(authService.login(loginInput)).rejects.toThrow(ForbiddenError);
      expect(mockedJwtHelper.sign).not.toHaveBeenCalled();
      expect(auditService.logLoginFailed).toHaveBeenCalledWith({
        userId: dbUser.id,
        ipAddress: null,
        userAgent: null,
      });
    });

    it('melempar UnauthorizedError ketika email tidak ditemukan, DAN mencatatnya sebagai percobaan gagal', async () => {
      userRepository.findByEmail.mockResolvedValue(null);

      await expect(authService.login(loginInput)).rejects.toThrow(UnauthorizedError);
      expect(mockedJwtHelper.sign).not.toHaveBeenCalled();
      expect(authRepository.createRefreshToken).not.toHaveBeenCalled();
      expect(mockedRecordFailedAttempt).toHaveBeenCalledWith(loginInput.email);
      // Tidak ada userId untuk dikaitkan (email tidak terdaftar), jadi
      // TIDAK boleh masuk ke AuditLog — beda dari kasus password salah
      // di bawah, di mana user-nya memang ada.
      expect(auditService.logLoginFailed).not.toHaveBeenCalled();
      // Regression test Finding #17 (timing attack/user enumeration) —
      // `bcrypt.compare` HARUS tetap dipanggil (terhadap hash palsu,
      // bukan `dbUser.password` — user ini bahkan tidak pernah
      // ditemukan) supaya durasi jalur ini menyerupai jalur "password
      // salah" di bawah, mencegah penyerang membedakan keduanya lewat
      // waktu respons.
      expect(mockedBcrypt.compare).toHaveBeenCalledWith(loginInput.password, expect.any(String));
    });

    it('melempar UnauthorizedError ketika password salah, DAN mencatatnya sebagai percobaan gagal (di tracker in-memory/Redis MAUPUN di AuditLog)', async () => {
      userRepository.findByEmail.mockResolvedValue(dbUser);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      await expect(authService.login(loginInput)).rejects.toThrow(UnauthorizedError);
      expect(mockedJwtHelper.sign).not.toHaveBeenCalled();
      expect(mockedRecordFailedAttempt).toHaveBeenCalledWith(loginInput.email);
      expect(auditService.logLoginFailed).toHaveBeenCalledWith({
        userId: dbUser.id,
        ipAddress: null,
        userAgent: null,
      });
    });

    it('melempar TooManyRequestsError TANPA menyentuh database sama sekali ketika akun sedang terkunci', async () => {
      mockedCheckAccountLock.mockResolvedValue({ locked: true, remainingSeconds: 300 });

      await expect(authService.login(loginInput)).rejects.toThrow(TooManyRequestsError);
      // Query user TIDAK boleh terjadi — akun yang terkunci ditolak
      // sebelum menyentuh database/bcrypt sama sekali (lihat komentar
      // di AuthService.login soal mencegah timing attack tambahan).
      expect(userRepository.findByEmail).not.toHaveBeenCalled();
      expect(mockedBcrypt.compare).not.toHaveBeenCalled();
    });

    // Phase 12 — MFA aktif.
    it('mengembalikan mfaRequired + challengeToken (BUKAN token asli) ketika MFA user aktif', async () => {
      userRepository.findByEmail.mockResolvedValue({ ...dbUser, mfaEnabled: true });
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedJwtHelper.signMfaChallenge.mockReturnValue('mfa.challenge.token');

      const result = await authService.login(loginInput);

      expect(result).toEqual({ mfaRequired: true, challengeToken: 'mfa.challenge.token' });
      // Kredensial pertama tetap mereset hitungan percobaan gagal —
      // password-nya memang benar, MFA cuma langkah tambahan.
      expect(mockedResetAttempts).toHaveBeenCalledWith(loginInput.email);
      // TIDAK BOLEH menerbitkan access/refresh token sungguhan di
      // titik ini — itulah inti dari "mfaRequired".
      expect(mockedJwtHelper.sign).not.toHaveBeenCalled();
      expect(authRepository.createRefreshToken).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // SUSPICIOUS SESSION DETECTION
  // ---------------------------------------------------------------
  describe('login — suspicious session detection', () => {
    const loginInput = { email: 'budi@example.com', password: 'plainPassword123' };
    const newDeviceContext = { userAgent: 'Mozilla/5.0', ipAddress: '203.0.113.99' };

    beforeEach(() => {
      userRepository.findByEmail.mockResolvedValue(dbUser);
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedJwtHelper.sign.mockReturnValue('signed.access.token');
      mockedGenerateRefreshToken.mockReturnValue('raw-refresh-token');
      authRepository.createRefreshToken.mockResolvedValue({} as never);
    });

    it('mencatat audit log + mengirim email ketika login berasal dari device belum dikenal', async () => {
      authRepository.countRefreshTokensForUser.mockResolvedValue(1); // pernah login sebelumnya
      authRepository.hasKnownDevice.mockResolvedValue(false); // device+IP ini belum pernah tercatat

      await authService.login(loginInput, newDeviceContext);

      expect(authRepository.hasKnownDevice).toHaveBeenCalledWith(
        dbUser.id,
        newDeviceContext.userAgent,
        newDeviceContext.ipAddress
      );
      expect(auditService.logSuspiciousLogin).toHaveBeenCalledWith({
        userId: dbUser.id,
        ipAddress: newDeviceContext.ipAddress,
        userAgent: newDeviceContext.userAgent,
      });
      expect(mockedEnqueueEmailJob).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'suspicious-login', to: dbUser.email })
      );
    });

    it('TIDAK menandai suspicious ketika device+IP sudah pernah dipakai user ini sebelumnya', async () => {
      authRepository.countRefreshTokensForUser.mockResolvedValue(3);
      authRepository.hasKnownDevice.mockResolvedValue(true);

      await authService.login(loginInput, newDeviceContext);

      expect(auditService.logSuspiciousLogin).not.toHaveBeenCalled();
      expect(mockedEnqueueEmailJob).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'suspicious-login' })
      );
    });

    it('TIDAK menandai suspicious untuk login PERTAMA user (belum ada device dikenal untuk dibandingkan)', async () => {
      authRepository.countRefreshTokensForUser.mockResolvedValue(0);

      await authService.login(loginInput, newDeviceContext);

      // Login pertama tidak pernah dianggap mencurigakan — pengecekan
      // `hasKnownDevice` bahkan tidak perlu dijalankan sama sekali.
      expect(authRepository.hasKnownDevice).not.toHaveBeenCalled();
      expect(auditService.logSuspiciousLogin).not.toHaveBeenCalled();
    });

    it('TIDAK menandai suspicious ketika deviceContext tidak lengkap (mis. IP tidak diketahui)', async () => {
      authRepository.countRefreshTokensForUser.mockResolvedValue(5);
      authRepository.hasKnownDevice.mockResolvedValue(false);

      await authService.login(loginInput, { userAgent: 'Mozilla/5.0', ipAddress: null });

      expect(authRepository.hasKnownDevice).not.toHaveBeenCalled();
      expect(auditService.logSuspiciousLogin).not.toHaveBeenCalled();
    });

    it('login tetap sukses walau pencatatan suspicious-login gagal (efek samping tidak boleh menggagalkan login)', async () => {
      authRepository.countRefreshTokensForUser.mockResolvedValue(1);
      authRepository.hasKnownDevice.mockResolvedValue(false);
      auditService.logSuspiciousLogin.mockRejectedValue(new Error('DB sedang down'));

      const result = await authService.login(loginInput, newDeviceContext);

      expect(result).toMatchObject({ accessToken: 'signed.access.token' });
    });
  });

  describe('verifyMfaLogin', () => {
    const verifyInput = { challengeToken: 'mfa.challenge.token', code: '123456' };

    it('menerbitkan accessToken + refreshToken ketika challenge token & kode MFA valid, DAN mereset hitungan percobaan MFA gagal', async () => {
      mockedJwtHelper.verifyMfaChallenge.mockReturnValue({
        type: 'mfa_challenge',
        userId: dbUser.id,
      });
      userRepository.findById.mockResolvedValue({ ...dbUser, mfaEnabled: true });
      mfaService.verifyCode.mockResolvedValue(true);
      mockedJwtHelper.sign.mockReturnValue('signed.access.token');
      mockedGenerateRefreshToken.mockReturnValue('raw-refresh-token');
      authRepository.createRefreshToken.mockResolvedValue({} as never);

      const result = await authService.verifyMfaLogin(verifyInput);

      expect(mfaService.verifyCode).toHaveBeenCalledWith(
        expect.objectContaining({ id: dbUser.id }),
        verifyInput.code
      );
      expect(result.accessToken).toBe('signed.access.token');
      // Finding #21 — identifier `mfa:<userId>`, BUKAN email, dan
      // terpisah dari lock milik login() (lihat 2 test di bawah).
      expect(mockedCheckAccountLock).toHaveBeenCalledWith(`mfa:${dbUser.id}`);
      expect(mockedResetAttempts).toHaveBeenCalledWith(`mfa:${dbUser.id}`);
    });

    it('melempar UnauthorizedError kalau challenge token tidak valid/kedaluwarsa', async () => {
      mockedJwtHelper.verifyMfaChallenge.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      await expect(authService.verifyMfaLogin(verifyInput)).rejects.toThrow(UnauthorizedError);
      expect(userRepository.findById).not.toHaveBeenCalled();
    });

    it('melempar TooManyRequestsError TANPA memanggil userRepository.findById ketika percobaan MFA sudah terkunci (Finding #21)', async () => {
      mockedJwtHelper.verifyMfaChallenge.mockReturnValue({
        type: 'mfa_challenge',
        userId: dbUser.id,
      });
      mockedCheckAccountLock.mockResolvedValue({ locked: true, remainingSeconds: 300 });

      await expect(authService.verifyMfaLogin(verifyInput)).rejects.toThrow(TooManyRequestsError);
      expect(mockedCheckAccountLock).toHaveBeenCalledWith(`mfa:${dbUser.id}`);
      expect(userRepository.findById).not.toHaveBeenCalled();
      expect(mfaService.verifyCode).not.toHaveBeenCalled();
    });

    it('melempar UnauthorizedError DAN mencatat percobaan gagal (Finding #21: identifier `mfa:<userId>`, terpisah dari lock login password) kalau kode MFA salah', async () => {
      mockedJwtHelper.verifyMfaChallenge.mockReturnValue({
        type: 'mfa_challenge',
        userId: dbUser.id,
      });
      userRepository.findById.mockResolvedValue({ ...dbUser, mfaEnabled: true });
      mfaService.verifyCode.mockResolvedValue(false);

      await expect(authService.verifyMfaLogin(verifyInput)).rejects.toThrow(UnauthorizedError);
      expect(auditService.logLoginFailed).toHaveBeenCalledWith({
        userId: dbUser.id,
        ipAddress: null,
        userAgent: null,
      });
      expect(mockedRecordFailedAttempt).toHaveBeenCalledWith(`mfa:${dbUser.id}`);
      expect(mockedJwtHelper.sign).not.toHaveBeenCalled();
    });

    it('melempar UnauthorizedError kalau MFA user sudah dinonaktifkan setelah challenge token diterbitkan', async () => {
      mockedJwtHelper.verifyMfaChallenge.mockReturnValue({
        type: 'mfa_challenge',
        userId: dbUser.id,
      });
      userRepository.findById.mockResolvedValue({ ...dbUser, mfaEnabled: false });

      await expect(authService.verifyMfaLogin(verifyInput)).rejects.toThrow(UnauthorizedError);
      expect(mfaService.verifyCode).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // REFRESH (rotasi + deteksi reuse)
  // ---------------------------------------------------------------
  describe('refresh', () => {
    const refreshInput = { refreshToken: 'incoming-refresh-token' };
    const futureDate = new Date(Date.now() + 60 * 60 * 1000);
    const pastDate = new Date(Date.now() - 60 * 60 * 1000);

    it('berhasil rotasi: mencabut token lama dan menerbitkan pasangan token baru, family ID diteruskan', async () => {
      const storedToken = {
        id: 'token-abc',
        tokenHash: 'hash-of-incoming-refresh-token',
        userId: dbUser.id,
        familyId: 'family-xyz',
        expiresAt: futureDate,
        // Finding #20 — batas absolut family, jauh lebih longgar dari
        // `futureDate` (1 jam) di sini supaya test rotasi normal ini
        // TIDAK ikut kena batas absolut; skenario batas absolut punya
        // test tersendiri di bawah.
        familySessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        // Phase 9 (refresh-token rotation) menambahkan `userAgent`/
        // `ipAddress` ke model `RefreshToken` — mock ini dibuat
        // sebelum itu, jadi belum pernah diupdate.
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
      };
      authRepository.findRefreshTokenByHash.mockResolvedValue(storedToken);
      userRepository.findById.mockResolvedValue(dbUser);
      authRepository.revokeRefreshTokenIfActive.mockResolvedValue(true);
      mockedJwtHelper.sign.mockReturnValue('new.access.token');
      mockedGenerateRefreshToken.mockReturnValue('new-raw-refresh-token');
      authRepository.createRefreshToken.mockResolvedValue({} as never);

      const result = await authService.refresh(refreshInput);

      // Token LAMA harus di-revoke — inti dari rotasi. Method ATOMIC
      // (`revokeRefreshTokenIfActive`, Finding #19) dipakai di sini,
      // BUKAN `revokeRefreshToken` biasa — lihat komentarnya di
      // `auth.repository.ts` untuk alasan race-condition lengkapnya.
      expect(authRepository.revokeRefreshTokenIfActive).toHaveBeenCalledWith(storedToken.id);
      expect(authRepository.revokeRefreshTokenFamily).not.toHaveBeenCalled();
      // Family ID token LAMA harus diteruskan ke baris BARU — bukan
      // family baru yang dibuat dari nol (lihat komentar `familyId`
      // di skema Prisma & `AuthService.refresh`).
      expect(authRepository.createRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ familyId: 'family-xyz' })
      );
      expect(result).toEqual({
        accessToken: 'new.access.token',
        refreshToken: 'new-raw-refresh-token',
      });
    });

    it('melempar UnauthorizedError ketika refresh token tidak ditemukan', async () => {
      authRepository.findRefreshTokenByHash.mockResolvedValue(null);

      await expect(authService.refresh(refreshInput)).rejects.toThrow(UnauthorizedError);
      expect(authRepository.revokeRefreshTokenIfActive).not.toHaveBeenCalled();
    });

    it('melempar UnauthorizedError ketika refresh token sudah kedaluwarsa', async () => {
      authRepository.findRefreshTokenByHash.mockResolvedValue({
        id: 'token-abc',
        tokenHash: 'hash-of-incoming-refresh-token',
        userId: dbUser.id,
        familyId: 'family-xyz',
        expiresAt: pastDate,
        familySessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
      });

      await expect(authService.refresh(refreshInput)).rejects.toThrow(UnauthorizedError);
      expect(authRepository.revokeRefreshTokenIfActive).not.toHaveBeenCalled();
      expect(authRepository.revokeAllRefreshTokensForUser).not.toHaveBeenCalled();
    });

    it('melempar UnauthorizedError DAN mencabut seluruh family ketika sesi sudah melewati batas absolut (Finding #20), walau `expiresAt` per-baris masih berlaku (terus dipakai/rotasi)', async () => {
      authRepository.findRefreshTokenByHash.mockResolvedValue({
        id: 'token-abc',
        tokenHash: 'hash-of-incoming-refresh-token',
        userId: dbUser.id,
        familyId: 'family-xyz',
        expiresAt: futureDate,
        familySessionExpiresAt: pastDate,
        revokedAt: null,
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
      });

      await expect(authService.refresh(refreshInput)).rejects.toThrow(UnauthorizedError);

      expect(authRepository.revokeRefreshTokenFamily).toHaveBeenCalledWith('family-xyz');
      expect(authRepository.revokeRefreshTokenIfActive).not.toHaveBeenCalled();
      expect(mockedJwtHelper.sign).not.toHaveBeenCalled();
    });

    it('MENCABUT seluruh FAMILY token ini (bukan seluruh sesi user) ketika refresh token yang sudah di-revoke dipakai lagi (deteksi reuse/pencurian token)', async () => {
      authRepository.findRefreshTokenByHash.mockResolvedValue({
        id: 'token-abc',
        tokenHash: 'hash-of-incoming-refresh-token',
        userId: dbUser.id,
        familyId: 'family-xyz',
        expiresAt: futureDate,
        familySessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revokedAt: new Date(), // sudah pernah dipakai sebelumnya
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
      });

      await expect(authService.refresh(refreshInput)).rejects.toThrow(UnauthorizedError);

      expect(authRepository.revokeRefreshTokenFamily).toHaveBeenCalledWith('family-xyz');
      // TIDAK boleh lagi mencabut SELURUH sesi user di semua device —
      // itu perilaku LAMA, digantikan pencabutan per-family (Phase 9).
      expect(authRepository.revokeAllRefreshTokensForUser).not.toHaveBeenCalled();
      // Tidak boleh sampai menerbitkan token baru dalam kondisi ini.
      expect(mockedJwtHelper.sign).not.toHaveBeenCalled();
    });

    /**
     * Regression test UTAMA Finding #19 — skenario RACE, beda dari
     * test reuse di atas (yang mensimulasikan `revokedAt` SUDAH
     * terisi SEJAK AWAL dibaca dari DB). Di sini `storedToken` yang
     * dibaca MASIH `revokedAt: null` (belum ada tanda reuse sama
     * sekali di titik baca) — tapi `revokeRefreshTokenIfActive`
     * (operasi ATOMIC di database) mengembalikan `false`, artinya
     * ADA REQUEST LAIN yang berhasil merevoke baris yang SAMA tepat
     * di antara pembacaan dan penulisan ini (persis kondisi race
     * yang jadi alasan Finding #19). Harus ditangani IDENTIK dengan
     * reuse biasa: cabut seluruh family, JANGAN sampai menerbitkan
     * token baru.
     */
    it('mendeteksi RACE CONDITION (revokeRefreshTokenIfActive mengembalikan false) sebagai reuse — mencabut family, TIDAK menerbitkan token baru', async () => {
      const storedToken = {
        id: 'token-abc',
        tokenHash: 'hash-of-incoming-refresh-token',
        userId: dbUser.id,
        familyId: 'family-xyz',
        expiresAt: futureDate,
        familySessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revokedAt: null, // BELUM revoked di titik baca — race terjadi setelah ini
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
      };
      authRepository.findRefreshTokenByHash.mockResolvedValue(storedToken);
      userRepository.findById.mockResolvedValue(dbUser);
      // Request LAIN "menang" race ini — update atomic gagal (0 baris
      // ter-affect) karena baris ini sudah direvoke barusan.
      authRepository.revokeRefreshTokenIfActive.mockResolvedValue(false);

      await expect(authService.refresh(refreshInput)).rejects.toThrow(UnauthorizedError);

      expect(authRepository.revokeRefreshTokenFamily).toHaveBeenCalledWith('family-xyz');
      expect(mockedJwtHelper.sign).not.toHaveBeenCalled();
      expect(authRepository.createRefreshToken).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // LOGOUT (revoke refresh token + blacklist access token)
  // ---------------------------------------------------------------
  describe('logout', () => {
    const accessTokenJti = 'jti-abc-123';
    const accessTokenExp = Math.floor(Date.now() / 1000) + 900; // 15 menit dari sekarang

    it('mem-blacklist access token DAN mencabut refresh token ketika keduanya valid', async () => {
      const storedToken = {
        id: 'token-abc',
        tokenHash: 'hash-of-my-refresh-token',
        userId: dbUser.id,
        familyId: 'family-xyz',
        expiresAt: new Date(Date.now() + 60_000),
        familySessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
      };
      authRepository.findRefreshTokenByHash.mockResolvedValue(storedToken);

      await authService.logout(dbUser.id, accessTokenJti, accessTokenExp, 'my-refresh-token');

      expect(mockedTokenBlacklist.add).toHaveBeenCalledWith({
        jti: accessTokenJti,
        userId: dbUser.id,
        expiresAt: new Date(accessTokenExp * 1000),
      });
      expect(authRepository.revokeRefreshToken).toHaveBeenCalledWith(storedToken.id);
    });

    it('TETAP mem-blacklist access token meski refresh token tidak ditemukan (idempotent, tanpa membocorkan informasi)', async () => {
      authRepository.findRefreshTokenByHash.mockResolvedValue(null);

      await expect(
        authService.logout(dbUser.id, accessTokenJti, accessTokenExp, 'unknown-token')
      ).resolves.toBeUndefined();

      expect(mockedTokenBlacklist.add).toHaveBeenCalledTimes(1);
      expect(authRepository.revokeRefreshToken).not.toHaveBeenCalled();
    });

    it('tidak mencabut refresh token ketika token tersebut milik user lain', async () => {
      authRepository.findRefreshTokenByHash.mockResolvedValue({
        id: 'token-abc',
        tokenHash: 'hash-of-someone-elses-token',
        userId: 'another-user-id',
        familyId: 'family-someone-else',
        expiresAt: new Date(Date.now() + 60_000),
        familySessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revokedAt: null,
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
      });

      await authService.logout(dbUser.id, accessTokenJti, accessTokenExp, 'someone-elses-token');

      expect(authRepository.revokeRefreshToken).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // VERIFY EMAIL
  // ---------------------------------------------------------------
  describe('verifyEmail', () => {
    it('berhasil menandai emailVerifiedAt dan menghapus token (single-use)', async () => {
      const storedToken = {
        id: 'evt-abc',
        tokenHash: 'hash-of-verify-token',
        userId: dbUser.id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      };
      authRepository.findEmailVerificationTokenByHash.mockResolvedValue(storedToken);
      userRepository.update.mockResolvedValue({ ...dbUser, emailVerifiedAt: new Date() });

      await authService.verifyEmail({ token: 'verify-token' });

      expect(userRepository.update).toHaveBeenCalledWith(
        dbUser.id,
        {
          emailVerifiedAt: expect.any(Date),
        },
        undefined
      );
      expect(authRepository.deleteEmailVerificationToken).toHaveBeenCalledWith(
        storedToken.id,
        undefined
      );
    });

    it('melempar UnauthorizedError ketika token tidak ditemukan', async () => {
      authRepository.findEmailVerificationTokenByHash.mockResolvedValue(null);

      await expect(authService.verifyEmail({ token: 'unknown' })).rejects.toThrow(
        UnauthorizedError
      );
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('melempar UnauthorizedError ketika token sudah kedaluwarsa', async () => {
      authRepository.findEmailVerificationTokenByHash.mockResolvedValue({
        id: 'evt-abc',
        tokenHash: 'hash-of-verify-token',
        userId: dbUser.id,
        expiresAt: new Date(Date.now() - 60_000),
        createdAt: new Date(),
      });

      await expect(authService.verifyEmail({ token: 'verify-token' })).rejects.toThrow(
        UnauthorizedError
      );
      expect(userRepository.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // FORGOT PASSWORD (enumeration-safe)
  // ---------------------------------------------------------------
  describe('forgotPassword', () => {
    it('menerbitkan token reset & mengirim email ketika akun ada', async () => {
      userRepository.findByEmail.mockResolvedValue(dbUser);

      await authService.forgotPassword({ email: dbUser.email });

      expect(authRepository.deleteAllPasswordResetTokensForUser).toHaveBeenCalledWith(dbUser.id);
      expect(authRepository.createPasswordResetToken).toHaveBeenCalledWith({
        tokenHash: 'hash-of-raw-secure-token',
        userId: dbUser.id,
        expiresAt: expect.any(Date),
      });
      expect(mockedEnqueueEmailJob).toHaveBeenCalledWith({
        type: 'password-reset',
        to: dbUser.email,
        token: 'raw-secure-token',
      });
    });

    it('diam-diam sukses TANPA menerbitkan token ketika email tidak terdaftar (mencegah user enumeration)', async () => {
      userRepository.findByEmail.mockResolvedValue(null);

      await expect(
        authService.forgotPassword({ email: 'tidak-ada@example.com' })
      ).resolves.toBeUndefined();

      expect(authRepository.createPasswordResetToken).not.toHaveBeenCalled();
      expect(mockedEnqueueEmailJob).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // RESET PASSWORD
  // ---------------------------------------------------------------
  describe('resetPassword', () => {
    it('berhasil reset password DAN mencabut seluruh sesi aktif user tersebut', async () => {
      const storedToken = {
        id: 'prt-abc',
        tokenHash: 'hash-of-reset-token',
        userId: dbUser.id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      };
      authRepository.findPasswordResetTokenByHash.mockResolvedValue(storedToken);
      mockedBcrypt.hash.mockResolvedValue('new-hashed-password' as never);
      userRepository.update.mockResolvedValue({ ...dbUser, password: 'new-hashed-password' });

      await authService.resetPassword({ token: 'reset-token', newPassword: 'NewPassword123' });

      expect(userRepository.update).toHaveBeenCalledWith(
        dbUser.id,
        {
          password: 'new-hashed-password',
        },
        undefined
      );
      expect(authRepository.deletePasswordResetToken).toHaveBeenCalledWith(
        storedToken.id,
        undefined
      );
      expect(authRepository.revokeAllRefreshTokensForUser).toHaveBeenCalledWith(
        dbUser.id,
        undefined
      );
    });

    it('melempar UnauthorizedError ketika token tidak ditemukan/kedaluwarsa', async () => {
      authRepository.findPasswordResetTokenByHash.mockResolvedValue(null);

      await expect(
        authService.resetPassword({ token: 'unknown', newPassword: 'NewPassword123' })
      ).rejects.toThrow(UnauthorizedError);
      expect(userRepository.update).not.toHaveBeenCalled();
      expect(authRepository.revokeAllRefreshTokensForUser).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // SESSION MANAGEMENT (Phase 7)
  // ---------------------------------------------------------------
  describe('listSessions', () => {
    const activeSessions = [
      {
        id: 'session-1',
        tokenHash: 'hash-current',
        userId: dbUser.id,
        userAgent: 'Chrome on macOS',
        ipAddress: '203.0.113.7',
        createdAt: new Date('2026-01-01'),
        expiresAt: new Date('2026-01-08'),
        revokedAt: null,
      },
      {
        id: 'session-2',
        tokenHash: 'hash-other-device',
        userId: dbUser.id,
        userAgent: 'Safari on iOS',
        ipAddress: '198.51.100.4',
        createdAt: new Date('2026-01-02'),
        expiresAt: new Date('2026-01-09'),
        revokedAt: null,
      },
    ];

    it('mengembalikan seluruh sesi aktif TANPA menandai isCurrent ketika currentRefreshToken tidak diberikan', async () => {
      authRepository.findActiveSessionsForUser.mockResolvedValue(activeSessions as never);

      const result = await authService.listSessions(dbUser.id);

      expect(authRepository.findActiveSessionsForUser).toHaveBeenCalledWith(dbUser.id);
      expect(result).toHaveLength(2);
      expect(result.every((session) => session.isCurrent === false)).toBe(true);
      // Field sensitif (tokenHash) TIDAK BOLEH ikut ke representasi publik.
      expect(result[0]).not.toHaveProperty('tokenHash');
    });

    it('menandai isCurrent=true HANYA pada sesi yang cocok dengan currentRefreshToken', async () => {
      authRepository.findActiveSessionsForUser.mockResolvedValue(activeSessions as never);
      mockedHashRefreshToken.mockImplementation(() => 'hash-current');

      const result = await authService.listSessions(dbUser.id, 'raw-current-refresh-token');

      expect(result.find((s) => s.id === 'session-1')?.isCurrent).toBe(true);
      expect(result.find((s) => s.id === 'session-2')?.isCurrent).toBe(false);
    });
  });

  describe('revokeSession', () => {
    it('mencabut sesi ketika ditemukan DAN memang milik user yang meminta', async () => {
      authRepository.findRefreshTokenById.mockResolvedValue({
        id: 'session-1',
        userId: dbUser.id,
        revokedAt: null,
      } as never);

      await authService.revokeSession(dbUser.id, 'session-1');

      expect(authRepository.revokeRefreshToken).toHaveBeenCalledWith('session-1');
    });

    it('melempar NotFoundError (BUKAN ForbiddenError) ketika sesi bukan milik user ini — mencegah bocor info kepemilikan', async () => {
      authRepository.findRefreshTokenById.mockResolvedValue({
        id: 'session-1',
        userId: 'user-lain',
        revokedAt: null,
      } as never);

      await expect(authService.revokeSession(dbUser.id, 'session-1')).rejects.toThrow(
        NotFoundError
      );
      expect(authRepository.revokeRefreshToken).not.toHaveBeenCalled();
    });

    it('melempar NotFoundError ketika sesi tidak ditemukan sama sekali', async () => {
      authRepository.findRefreshTokenById.mockResolvedValue(null);

      await expect(authService.revokeSession(dbUser.id, 'tidak-ada')).rejects.toThrow(
        NotFoundError
      );
    });

    it('TIDAK memanggil revokeRefreshToken lagi kalau sesi sudah revoked sebelumnya (idempotent)', async () => {
      authRepository.findRefreshTokenById.mockResolvedValue({
        id: 'session-1',
        userId: dbUser.id,
        revokedAt: new Date(),
      } as never);

      await authService.revokeSession(dbUser.id, 'session-1');

      expect(authRepository.revokeRefreshToken).not.toHaveBeenCalled();
    });
  });
});
