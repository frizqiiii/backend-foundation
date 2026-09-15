import type { PrismaClient, SsoConnection, SsoIdentity } from '@prisma/client';

/**
 * Repository Layer untuk `SsoConnection` (konfigurasi OIDC per
 * tenant) dan `SsoIdentity` (tautan User <-> `sub` OIDC) — digabung
 * dalam satu file (pola sama seperti `MfaRepository`) karena
 * keduanya SELALU dipakai bersamaan dari sudut pandang satu alur
 * SSO: mencari konfigurasi tenant, lalu mencari/membuat identitas
 * user di dalamnya.
 */
export class SsoConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTenantId(tenantId: string): Promise<SsoConnection | null> {
    return this.prisma.ssoConnection.findUnique({ where: { tenantId } });
  }

  /**
   * Upsert SENGAJA (bukan create/update terpisah) — endpoint admin
   * `PUT /auth/admin/sso/:tenantSlug` merepresentasikan "keadaan
   * konfigurasi SSO tenant ini SEHARUSNYA begini", bukan dua operasi
   * berbeda (admin tidak perlu tahu/peduli apakah ini konfigurasi
   * pertama kali atau mengganti yang sudah ada — `@@unique([tenantId])`
   * di schema sudah menjamin maksimal satu baris per tenant).
   */
  async upsert(params: {
    tenantId: string;
    issuerUrl: string;
    clientId: string;
    clientSecretEncrypted: string;
    allowedEmailDomain: string;
    enabled: boolean;
  }): Promise<SsoConnection> {
    const { tenantId, ...data } = params;
    return this.prisma.ssoConnection.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
  }
}

export class SsoIdentityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTenantAndSubject(tenantId: string, subject: string): Promise<SsoIdentity | null> {
    return this.prisma.ssoIdentity.findUnique({
      where: { tenantId_subject: { tenantId, subject } },
    });
  }

  async create(params: {
    tenantId: string;
    subject: string;
    userId: string;
  }): Promise<SsoIdentity> {
    return this.prisma.ssoIdentity.create({ data: params });
  }
}
