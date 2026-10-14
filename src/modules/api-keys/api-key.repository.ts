import type { PrismaClient, ApiKey } from '@prisma/client';
import { getScopedPrisma, withRlsBypass } from '../../shared/tenant/tenant-context';

export class ApiKeyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    userId: string;
    tenantId: string | null;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    expiresAt: Date | null;
  }): Promise<ApiKey> {
    return getScopedPrisma(this.prisma).apiKey.create({ data });
  }

  /**
   * Lookup lewat `keyHash` (indexed unique, lihat schema.prisma) —
   * SATU-SATUNYA cara sistem mengenali API key yang datang lewat
   * header `Authorization`. TIDAK memfilter `revokedAt`/`expiresAt`
   * di query ini — pemanggil (`ApiKeyService.authenticate`) yang
   * memutuskan & melempar error yang sesuai (revoked vs expired vs
   * tidak ditemukan sama sekali) supaya pesan errornya bisa
   * dibedakan, bukan disamakan jadi satu "tidak ditemukan" generik.
   */
  async findByHash(keyHash: string): Promise<ApiKey | null> {
    // R17 (RLS) — autentikasi API key terjadi SEBELUM tenant diketahui (tenant justru ada di baris key ini),
    // jadi lookup-nya sengaja memakai bypass RLS. Aman: dicari lewat SHA-256 dari key lengkap (entropi tinggi,
    // bukan tebakan) dan hanya SATU baris dibaca; tenant pemiliknya divalidasi aktif sesudahnya oleh pemanggil.
    return withRlsBypass(this.prisma, (tx) => tx.apiKey.findUnique({ where: { keyHash } }));
  }

  async findManyForUser(userId: string): Promise<ApiKey[]> {
    return getScopedPrisma(this.prisma).apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByIdForUser(id: string, userId: string): Promise<ApiKey | null> {
    return getScopedPrisma(this.prisma).apiKey.findFirst({ where: { id, userId } });
  }

  /**
   * T4 — TIDAK di-scope ke `userId`, beda dari `findByIdForUser` di
   * atas: dipakai jalur admin (`ApiKeyService.updateRateLimitOverride`,
   * permission `api-key.manage`) yang justru HARUS bisa menjangkau
   * key milik user MANA PUN.
   */
  async findById(id: string): Promise<ApiKey | null> {
    return getScopedPrisma(this.prisma).apiKey.findUnique({ where: { id } });
  }

  /**
   * T4 — `value` `null` MENGHAPUS override (kembali memakai tier plan
   * tenant seperti biasa), bukan sekadar "tidak diisi" — beda dari
   * kolom lain di model ini yang nullable karena BELUM diisi.
   */
  async updateRateLimitOverride(id: string, value: number | null): Promise<ApiKey> {
    return getScopedPrisma(this.prisma).apiKey.update({
      where: { id },
      data: { rateLimitOverridePerMinute: value },
    });
  }

  async revoke(id: string): Promise<ApiKey> {
    return getScopedPrisma(this.prisma).apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  async touchLastUsed(id: string): Promise<void> {
    // R17 (RLS) — dipanggil dari jalur autentikasi API key (tanpa tenant context), jadi sama seperti `findByHash`.
    await withRlsBypass(this.prisma, (tx) =>
      tx.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } })
    );
  }
}
