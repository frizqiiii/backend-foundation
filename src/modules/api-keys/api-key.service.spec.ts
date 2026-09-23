import { ApiKeyService } from './api-key.service';
import type { ApiKeyRepository } from './api-key.repository';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../shared/utils/http-error';

describe('ApiKeyService', () => {
  let apiKeyRepository: jest.Mocked<ApiKeyRepository>;
  let apiKeyService: ApiKeyService;

  const owner = { id: 'user-1', role: 'ORGANIZER' as const };

  const storedApiKey = {
    id: 'key-1',
    userId: owner.id,
    tenantId: null,
    name: 'CI pipeline',
    keyPrefix: 'bfk_aaaaaaaa',
    keyHash: 'irrelevant-for-these-tests',
    scopes: ['event.read', 'event.create'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(),
    rateLimitOverridePerMinute: null,
  };

  beforeEach(() => {
    apiKeyRepository = {
      create: jest.fn(),
      findByHash: jest.fn(),
      findManyForUser: jest.fn(),
      findByIdForUser: jest.fn(),
      findById: jest.fn(),
      revoke: jest.fn(),
      updateRateLimitOverride: jest.fn(),
      touchLastUsed: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ApiKeyRepository>;

    apiKeyService = new ApiKeyService(apiKeyRepository);
  });

  describe('create', () => {
    it('mewarisi SELURUH permission role pemiliknya kalau scopes tidak diisi', async () => {
      apiKeyRepository.create.mockResolvedValue(storedApiKey);

      await apiKeyService.create(owner, { name: 'CI pipeline' });

      const [createArgs] = apiKeyRepository.create.mock.calls[0];
      // ORGANIZER punya beberapa permission (lihat permissions.ts) — key tanpa scope eksplisit mewarisi semuanya.
      expect(createArgs.scopes.length).toBeGreaterThan(0);
      expect(createArgs.scopes).toContain('event.create');
    });

    it('menerima scopes yang merupakan subset permission role pemiliknya', async () => {
      apiKeyRepository.create.mockResolvedValue(storedApiKey);

      await apiKeyService.create(owner, { name: 'Read-only key', scopes: ['event.read'] });

      const [createArgs] = apiKeyRepository.create.mock.calls[0];
      expect(createArgs.scopes).toEqual(['event.read']);
    });

    it('melempar ForbiddenError kalau scopes yang diminta MELEBIHI permission role pemiliknya', async () => {
      // ORGANIZER tidak punya 'user.manage' (lihat permissions.ts).
      await expect(
        apiKeyService.create(owner, { name: 'Escalation attempt', scopes: ['user.manage'] })
      ).rejects.toThrow(ForbiddenError);
      expect(apiKeyRepository.create).not.toHaveBeenCalled();
    });

    it('melempar BadRequestError kalau expiresAt bukan di masa depan', async () => {
      await expect(
        apiKeyService.create(owner, { name: 'Expired', expiresAt: '2020-01-01T00:00:00.000Z' })
      ).rejects.toThrow(BadRequestError);
    });

    it('rawKey yang dikembalikan berawalan bfk_ dan TIDAK PERNAH sama dengan keyHash yang disimpan', async () => {
      apiKeyRepository.create.mockResolvedValue(storedApiKey);

      const result = await apiKeyService.create(owner, { name: 'CI pipeline' });

      expect(result.rawKey).toMatch(/^bfk_[0-9a-f]{64}$/);
      const [createArgs] = apiKeyRepository.create.mock.calls[0];
      expect(createArgs.keyHash).not.toBe(result.rawKey);
      expect(createArgs.keyPrefix).toBe(result.rawKey.slice(0, 12));
    });
  });

  describe('authenticate', () => {
    it('melempar UnauthorizedError kalau key tidak ditemukan', async () => {
      apiKeyRepository.findByHash.mockResolvedValue(null);
      await expect(apiKeyService.authenticate('bfk_unknown')).rejects.toThrow(UnauthorizedError);
    });

    it('melempar UnauthorizedError kalau key sudah revoked', async () => {
      apiKeyRepository.findByHash.mockResolvedValue({ ...storedApiKey, revokedAt: new Date() });
      await expect(apiKeyService.authenticate('bfk_x')).rejects.toThrow(UnauthorizedError);
    });

    it('melempar UnauthorizedError kalau key sudah kedaluwarsa', async () => {
      apiKeyRepository.findByHash.mockResolvedValue({
        ...storedApiKey,
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      await expect(apiKeyService.authenticate('bfk_x')).rejects.toThrow(UnauthorizedError);
    });

    it('mengembalikan userId+scopes dan memperbarui lastUsedAt kalau key valid', async () => {
      apiKeyRepository.findByHash.mockResolvedValue(storedApiKey);

      const result = await apiKeyService.authenticate('bfk_x');

      expect(result).toEqual({
        apiKeyId: storedApiKey.id,
        userId: storedApiKey.userId,
        tenantId: storedApiKey.tenantId,
        scopes: storedApiKey.scopes,
        expiresAt: null,
        rateLimitOverridePerMinute: null,
      });
      expect(apiKeyRepository.touchLastUsed).toHaveBeenCalledWith(storedApiKey.id);
    });

    it('P3 — TIDAK melempar error kalau touchLastUsed gagal (fire-and-forget, tidak boleh menggagalkan autentikasi yang sudah lolos validasi)', async () => {
      apiKeyRepository.findByHash.mockResolvedValue(storedApiKey);
      apiKeyRepository.touchLastUsed.mockRejectedValue(new Error('DB lambat'));

      await expect(apiKeyService.authenticate('bfk_x')).resolves.toEqual({
        apiKeyId: storedApiKey.id,
        userId: storedApiKey.userId,
        tenantId: storedApiKey.tenantId,
        scopes: storedApiKey.scopes,
        expiresAt: null,
        rateLimitOverridePerMinute: null,
      });
    });

    it('item 2.11 — mengembalikan tenantId pemilik key (dipakai gateway untuk memilih kuota per plan)', async () => {
      apiKeyRepository.findByHash.mockResolvedValue({ ...storedApiKey, tenantId: 'tenant-acme' });

      const result = await apiKeyService.authenticate('bfk_x');

      expect(result.tenantId).toBe('tenant-acme');
    });

    it('T4 — mengembalikan rateLimitOverridePerMinute dari row yang sama (TANPA query tambahan)', async () => {
      apiKeyRepository.findByHash.mockResolvedValue({
        ...storedApiKey,
        rateLimitOverridePerMinute: 500,
      });

      const result = await apiKeyService.authenticate('bfk_x');

      expect(result.rateLimitOverridePerMinute).toBe(500);
    });
  });

  describe('revoke', () => {
    it('melempar NotFoundError kalau key tidak ditemukan/bukan milik user ini', async () => {
      apiKeyRepository.findByIdForUser.mockResolvedValue(null);
      await expect(apiKeyService.revoke(owner.id, 'key-x')).rejects.toThrow(NotFoundError);
    });

    it('idempotent — tidak error kalau key sudah revoked sebelumnya', async () => {
      apiKeyRepository.findByIdForUser.mockResolvedValue({
        ...storedApiKey,
        revokedAt: new Date(),
      });
      await apiKeyService.revoke(owner.id, storedApiKey.id);
      expect(apiKeyRepository.revoke).not.toHaveBeenCalled();
    });

    it('mencabut key yang ditemukan & belum revoked', async () => {
      apiKeyRepository.findByIdForUser.mockResolvedValue(storedApiKey);
      await apiKeyService.revoke(owner.id, storedApiKey.id);
      expect(apiKeyRepository.revoke).toHaveBeenCalledWith(storedApiKey.id);
    });
  });

  describe('updateRateLimitOverride (T4)', () => {
    it('melempar NotFoundError kalau key tidak ada, TANPA menulis apa pun', async () => {
      apiKeyRepository.findById.mockResolvedValue(null);

      await expect(apiKeyService.updateRateLimitOverride('key-x', 500)).rejects.toThrow(
        NotFoundError
      );
      expect(apiKeyRepository.updateRateLimitOverride).not.toHaveBeenCalled();
    });

    it('TIDAK di-scope ke pemilik — bisa menjangkau key milik user MANA PUN (beda dari revoke)', async () => {
      apiKeyRepository.findById.mockResolvedValue({ ...storedApiKey, userId: 'user-lain' });
      apiKeyRepository.updateRateLimitOverride.mockResolvedValue({
        ...storedApiKey,
        userId: 'user-lain',
        rateLimitOverridePerMinute: 500,
      });

      await apiKeyService.updateRateLimitOverride(storedApiKey.id, 500);

      expect(apiKeyRepository.findById).toHaveBeenCalledWith(storedApiKey.id);
      expect(apiKeyRepository.updateRateLimitOverride).toHaveBeenCalledWith(storedApiKey.id, 500);
    });

    it('mengembalikan nilai SEBELUMNYA (dibaca sebelum menulis) supaya controller bisa mencatat "dari -> ke" — pola sama seperti TenantService (T2/T3)', async () => {
      apiKeyRepository.findById.mockResolvedValue({
        ...storedApiKey,
        rateLimitOverridePerMinute: 100,
      });
      apiKeyRepository.updateRateLimitOverride.mockResolvedValue({
        ...storedApiKey,
        rateLimitOverridePerMinute: 500,
      });

      const result = await apiKeyService.updateRateLimitOverride(storedApiKey.id, 500);

      expect(result.previousValue).toBe(100);
      expect(result.apiKey.rateLimitOverridePerMinute).toBe(500);
    });

    it('null MENGHAPUS override (kembali ke tier plan tenant)', async () => {
      apiKeyRepository.findById.mockResolvedValue({
        ...storedApiKey,
        rateLimitOverridePerMinute: 500,
      });
      apiKeyRepository.updateRateLimitOverride.mockResolvedValue({
        ...storedApiKey,
        rateLimitOverridePerMinute: null,
      });

      await apiKeyService.updateRateLimitOverride(storedApiKey.id, null);

      expect(apiKeyRepository.updateRateLimitOverride).toHaveBeenCalledWith(storedApiKey.id, null);
    });
  });
});
