import type { PrismaClient } from '@prisma/client';
import { WebhookRepository } from './webhook.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    webhookEndpoint: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('WebhookRepository', () => {
  it('create memetakan encryptedSecret ke kolom secret di prisma', async () => {
    const prisma = createMockPrisma();
    const created = { id: 'w1' };
    (prisma.webhookEndpoint.create as jest.Mock).mockResolvedValue(created);
    const repository = new WebhookRepository(prisma);

    const result = await repository.create({
      userId: 'u1',
      tenantId: null,
      url: 'https://example.com/hook',
      encryptedSecret: 'enc-secret',
      eventTypes: ['event.created'],
    });

    expect(prisma.webhookEndpoint.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        tenantId: null,
        url: 'https://example.com/hook',
        secret: 'enc-secret',
        eventTypes: ['event.created'],
      },
    });
    expect(result).toBe(created);
  });

  it('findManyForUser mengambil endpoint milik user, urut createdAt desc', async () => {
    const prisma = createMockPrisma();
    const endpoints = [{ id: 'w1' }];
    (prisma.webhookEndpoint.findMany as jest.Mock).mockResolvedValue(endpoints);
    const repository = new WebhookRepository(prisma);

    const result = await repository.findManyForUser('u1');

    expect(prisma.webhookEndpoint.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toBe(endpoints);
  });

  it('findByIdForUser mencari endpoint spesifik milik user (scoped)', async () => {
    const prisma = createMockPrisma();
    (prisma.webhookEndpoint.findFirst as jest.Mock).mockResolvedValue(null);
    const repository = new WebhookRepository(prisma);

    await repository.findByIdForUser('w1', 'u1');

    expect(prisma.webhookEndpoint.findFirst).toHaveBeenCalledWith({
      where: { id: 'w1', userId: 'u1' },
    });
  });

  it('revoke menonaktifkan endpoint dan mengisi revokedAt', async () => {
    const prisma = createMockPrisma();
    const revoked = { id: 'w1', active: false };
    (prisma.webhookEndpoint.update as jest.Mock).mockResolvedValue(revoked);
    const repository = new WebhookRepository(prisma);

    const result = await repository.revoke('w1');

    expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { active: false, revokedAt: expect.any(Date) },
    });
    expect(result).toBe(revoked);
  });

  describe('findActiveByEventType', () => {
    it('TANPA tenantId: filter active + eventTypes.has, tanpa filter tenantId', async () => {
      const prisma = createMockPrisma();
      (prisma.webhookEndpoint.findMany as jest.Mock).mockResolvedValue([]);
      const repository = new WebhookRepository(prisma);

      await repository.findActiveByEventType('event.created', null);

      expect(prisma.webhookEndpoint.findMany).toHaveBeenCalledWith({
        where: {
          active: true,
          eventTypes: { has: 'event.created' },
        },
      });
    });

    it('DENGAN tenantId: menambahkan filter tenantId ke where', async () => {
      const prisma = createMockPrisma();
      (prisma.webhookEndpoint.findMany as jest.Mock).mockResolvedValue([]);
      const repository = new WebhookRepository(prisma);

      await repository.findActiveByEventType('event.created', 'tenant-1');

      expect(prisma.webhookEndpoint.findMany).toHaveBeenCalledWith({
        where: {
          active: true,
          eventTypes: { has: 'event.created' },
          tenantId: 'tenant-1',
        },
      });
    });
  });
});
