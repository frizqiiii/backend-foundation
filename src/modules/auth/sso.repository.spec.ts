import type { PrismaClient } from '@prisma/client';
import { SsoConnectionRepository, SsoIdentityRepository } from './sso.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    ssoConnection: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    ssoIdentity: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('SsoConnectionRepository', () => {
  it('findByTenantId mencari lewat unique index tenantId', async () => {
    const prisma = createMockPrisma();
    (prisma.ssoConnection.findUnique as jest.Mock).mockResolvedValue({ tenantId: 't1' });
    const repository = new SsoConnectionRepository(prisma);

    const result = await repository.findByTenantId('t1');

    expect(prisma.ssoConnection.findUnique).toHaveBeenCalledWith({ where: { tenantId: 't1' } });
    expect(result).toEqual({ tenantId: 't1' });
  });

  it('upsert memakai tenantId sebagai kunci upsert (create kalau belum ada, update kalau sudah)', async () => {
    const prisma = createMockPrisma();
    (prisma.ssoConnection.upsert as jest.Mock).mockResolvedValue({ tenantId: 't1' });
    const repository = new SsoConnectionRepository(prisma);

    const params = {
      tenantId: 't1',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-abc',
      clientSecretEncrypted: 'enc:...',
      allowedEmailDomain: 'acme.com',
      enabled: true,
    };

    await repository.upsert(params);

    expect(prisma.ssoConnection.upsert).toHaveBeenCalledWith({
      where: { tenantId: 't1' },
      create: params,
      update: {
        issuerUrl: params.issuerUrl,
        clientId: params.clientId,
        clientSecretEncrypted: params.clientSecretEncrypted,
        allowedEmailDomain: params.allowedEmailDomain,
        enabled: params.enabled,
      },
    });
  });
});

describe('SsoIdentityRepository', () => {
  it('findByTenantAndSubject mencari lewat compound unique index [tenantId, subject]', async () => {
    const prisma = createMockPrisma();
    (prisma.ssoIdentity.findUnique as jest.Mock).mockResolvedValue({ userId: 'u1' });
    const repository = new SsoIdentityRepository(prisma);

    const result = await repository.findByTenantAndSubject('t1', 'sub-1');

    expect(prisma.ssoIdentity.findUnique).toHaveBeenCalledWith({
      where: { tenantId_subject: { tenantId: 't1', subject: 'sub-1' } },
    });
    expect(result).toEqual({ userId: 'u1' });
  });

  it('create menautkan tenantId+subject+userId', async () => {
    const prisma = createMockPrisma();
    (prisma.ssoIdentity.create as jest.Mock).mockResolvedValue({ id: 'identity-1' });
    const repository = new SsoIdentityRepository(prisma);

    await repository.create({ tenantId: 't1', subject: 'sub-1', userId: 'u1' });

    expect(prisma.ssoIdentity.create).toHaveBeenCalledWith({
      data: { tenantId: 't1', subject: 'sub-1', userId: 'u1' },
    });
  });
});
