import type { PrismaClient, ApiKey } from '@prisma/client';

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
    return this.prisma.apiKey.create({ data });
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
    return this.prisma.apiKey.findUnique({ where: { keyHash } });
  }

  async findManyForUser(userId: string): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async findByIdForUser(id: string, userId: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findFirst({ where: { id, userId } });
  }

  async revoke(id: string): Promise<ApiKey> {
    return this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } });
  }
}
