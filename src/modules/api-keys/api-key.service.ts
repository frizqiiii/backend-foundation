import crypto from 'node:crypto';
import type { ApiKey } from '@prisma/client';
import type { ApiKeyRepository } from './api-key.repository';
import type { CreateApiKeyDto, CreateApiKeyResponseDto, ApiKeySummaryDto } from './api-key.dto';
import { getPermissionsForRole, type Permission } from '../../shared/security/permissions';
import type { RoleName } from '../../shared/types/role';
import { getTenantContext } from '../../shared/tenant/tenant-context';
import { logger } from '../../shared/logger';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../shared/utils/http-error';

/** Prefix tetap di depan SETIAP key mentah — memudahkan secret-scanning
 * tool (mis. GitHub secret scanning, gitleaks) mengenali pola key
 * aplikasi ini kalau tidak sengaja ter-commit, sekaligus langsung
 * membedakan key aplikasi ini dari token JWT/secret lain di log. */
const KEY_PREFIX = 'bfk';
/** Panjang bagian acak (byte, sebelum di-hex-kan jadi 2x panjangnya) — 32 byte = 256 bit, jauh di atas cukup untuk tidak bisa ditebak brute-force. */
const RAW_KEY_RANDOM_BYTES = 32;
/** Berapa karakter dari key LENGKAP yang disimpan polos sebagai `keyPrefix` untuk identifikasi di UI (lihat komentar `ApiKey.keyPrefix` di schema.prisma). */
const DISPLAY_PREFIX_LENGTH = 12;

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export class ApiKeyService {
  constructor(private readonly apiKeyRepository: ApiKeyRepository) {}

  /**
   * `owner` WAJIB dioper (bukan sekadar `userId`) — validasi scope di
   * bawah butuh `owner.role` untuk memastikan key yang dibuat TIDAK
   * BOLEH melebihi permission pemiliknya sendiri saat ini (kalau role
   * pemilik nanti diturunkan, key lama TETAP membawa scope lama —
   * lihat catatan "Belum ditegakkan" di `docs/security-guide.md`
   * untuk kenapa itu keputusan sadar, bukan celah yang terlewat).
   */
  async create(
    owner: { id: string; role: RoleName },
    input: CreateApiKeyDto
  ): Promise<CreateApiKeyResponseDto> {
    const scopes = this.resolveScopes(owner.role, input.scopes);

    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestError('expiresAt harus di masa depan');
    }

    const rawKey = `${KEY_PREFIX}_${crypto.randomBytes(RAW_KEY_RANDOM_BYTES).toString('hex')}`;
    const { tenantId } = getTenantContext();

    const apiKey = await this.apiKeyRepository.create({
      userId: owner.id,
      tenantId,
      name: input.name,
      keyPrefix: rawKey.slice(0, DISPLAY_PREFIX_LENGTH),
      keyHash: hashKey(rawKey),
      scopes,
      expiresAt,
    });

    // `rawKey` HANYA muncul di sini — lihat komentar lengkap di
    // `CreateApiKeyResponseDto`.
    return {
      id: apiKey.id,
      name: apiKey.name,
      rawKey,
      keyPrefix: apiKey.keyPrefix,
      scopes: apiKey.scopes,
      expiresAt: apiKey.expiresAt,
    };
  }

  async listForUser(userId: string): Promise<ApiKeySummaryDto[]> {
    const keys = await this.apiKeyRepository.findManyForUser(userId);
    return keys.map((key) => this.toSummaryDto(key));
  }

  async revoke(userId: string, apiKeyId: string): Promise<void> {
    const apiKey = await this.apiKeyRepository.findByIdForUser(apiKeyId, userId);
    if (!apiKey) {
      // NotFoundError, BUKAN ForbiddenError, kalau key milik user
      // lain — pola yang sama dengan `AuthService.revokeSession`
      // (lihat komentar di sana): mencegah bocor informasi
      // "kepemilikan key ini ada, cuma bukan punyamu".
      throw new NotFoundError('API key tidak ditemukan');
    }
    if (apiKey.revokedAt) {
      return; // idempotent — revoke dua kali bukan error
    }
    await this.apiKeyRepository.revoke(apiKeyId);
  }

  /**
   * T4 — admin (`api-key.manage`), TIDAK di-scope ke `userId` (beda
   * dari `revoke` di atas) — SENGAJA: memberi pengecualian kuota
   * adalah keputusan platform, boleh dilakukan ke key MILIK USER MANA
   * PUN, bukan cuma milik sendiri. Mengembalikan nilai SEBELUMNYA
   * (dibaca sebelum menulis) — pola sama seperti
   * `TenantService.updateStatus`/`updatePlan` (T2/T3) — supaya
   * controller bisa mencatat "dari -> ke" di audit log.
   */
  async updateRateLimitOverride(
    apiKeyId: string,
    value: number | null
  ): Promise<{ apiKey: ApiKey; previousValue: number | null }> {
    const existing = await this.apiKeyRepository.findById(apiKeyId);
    if (!existing) {
      throw new NotFoundError('API key tidak ditemukan');
    }
    const updated = await this.apiKeyRepository.updateRateLimitOverride(apiKeyId, value);
    return { apiKey: updated, previousValue: existing.rateLimitOverridePerMinute };
  }

  /**
   * Dipanggil `apiKeyAuthMiddleware` untuk SETIAP request yang
   * memakai API key alih-alih JWT — melempar `UnauthorizedError`
   * untuk key yang tidak dikenal/revoked/kedaluwarsa. `lastUsedAt`
   * diupdate SETELAH validasi lolos (bukan sebelum) supaya key yang
   * gagal divalidasi tidak ikut mengubah state apa pun.
   */
  async authenticate(rawKey: string): Promise<{
    apiKeyId: string;
    userId: string;
    // Fase 2 (item 2.11) — dipakai gateway per-API-key untuk memilih
    // kuota sesuai plan tenant pemilik key. `null` = key tanpa tenant
    // (masa transisi Phase 11) -> tier default.
    tenantId: string | null;
    scopes: Permission[];
    expiresAt: Date | null;
    // T4 — override kuota per-menit KHUSUS key ini (`null` = tidak
    // ada, pakai tier plan seperti biasa). Diambil dari row yang SAMA
    // yang sudah di-fetch untuk validasi key di atas — TIDAK ada query
    // tambahan untuk field ini.
    rateLimitOverridePerMinute: number | null;
  }> {
    const apiKey = await this.apiKeyRepository.findByHash(hashKey(rawKey));
    if (!apiKey) {
      throw new UnauthorizedError('API key tidak valid');
    }
    if (apiKey.revokedAt) {
      throw new UnauthorizedError('API key sudah dicabut');
    }
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedError('API key sudah kedaluwarsa');
    }

    // P3 (Database Audit) — SEBELUMNYA di-`await` di sini, artinya
    // SETIAP request yang autentikasi lewat API key (jalur yang bisa
    // sangat sering dipakai, mis. integrasi CI/CD yang polling) harus
    // menunggu satu UPDATE database murni untuk field analytics
    // (`lastUsedAt`) selesai sebelum request bisa lanjut — menambah
    // latency ke jalur autentikasi untuk sesuatu yang TIDAK memengaruhi
    // keputusan otorisasi apa pun. Sekarang fire-and-forget: request
    // lanjut TANPA menunggu; kegagalan (mis. DB sedang lambat) hanya
    // di-log sebagai warning, tidak pernah menggagalkan autentikasi
    // yang sudah lolos validasi di atas.
    this.apiKeyRepository.touchLastUsed(apiKey.id).catch((error: unknown) => {
      logger.warn({ err: error, apiKeyId: apiKey.id }, 'Gagal memperbarui lastUsedAt API key');
    });

    return {
      apiKeyId: apiKey.id,
      userId: apiKey.userId,
      tenantId: apiKey.tenantId,
      scopes: apiKey.scopes as Permission[],
      expiresAt: apiKey.expiresAt,
      rateLimitOverridePerMinute: apiKey.rateLimitOverridePerMinute,
    };
  }

  /**
   * Scope KOSONG/tidak diisi → warisi SELURUH permission role
   * pemiliknya (lihat komentar `createApiKeySchema.scopes`). Scope
   * yang diisi WAJIB subset permission role pemiliknya — melempar
   * `ForbiddenError` (bukan `BadRequestError`) untuk permission yang
   * diminta tapi tidak dimiliki, karena ini secara substansi adalah
   * percobaan eskalasi hak akses, bukan sekadar input yang salah
   * format.
   */
  private resolveScopes(role: RoleName, requestedScopes: string[] | undefined): string[] {
    const ownerPermissions = getPermissionsForRole(role);
    if (!requestedScopes || requestedScopes.length === 0) {
      return [...ownerPermissions];
    }

    const disallowed = requestedScopes.filter(
      (scope) => !ownerPermissions.includes(scope as Permission)
    );
    if (disallowed.length > 0) {
      throw new ForbiddenError(
        `Scope berikut melebihi permission Anda sendiri: ${disallowed.join(', ')}`
      );
    }

    return requestedScopes;
  }

  private toSummaryDto(key: ApiKey): ApiKeySummaryDto {
    return {
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
      createdAt: key.createdAt,
    };
  }
}
