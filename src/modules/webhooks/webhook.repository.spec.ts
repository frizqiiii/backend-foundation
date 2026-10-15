import type { Prisma, PrismaClient } from '@prisma/client';
import { WebhookRepository } from './webhook.repository';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';

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

  // R18 — `webhook_endpoints` ber-FORCE RLS. Saat request membawa tenant (`tenantMiddleware`), context membawa `tx`
  // yang sudah `set_config('app.tenant_id')`. SEMUA method harus memakai `tx` itu; `this.prisma` = koneksi tanpa
  // `app.tenant_id` sehingga create ditolak 42501 dan findMany kosong.
  describe('DENGAN transaction client tenant (RLS): memakai tx, BUKAN this.prisma', () => {
    function createMockTx() {
      return {
        webhookEndpoint: {
          create: jest.fn(),
          findMany: jest.fn(),
          findFirst: jest.fn(),
          update: jest.fn(),
        },
      };
    }

    function withTx<T>(tx: ReturnType<typeof createMockTx>, fn: () => T): T {
      return runWithTenantContext(
        {
          tenantId: 'tenant-1',
          tenantSlug: 'acme',
          db: tx as unknown as Prisma.TransactionClient,
        },
        fn
      );
    }

    function expectPrismaUntouched(prisma: PrismaClient) {
      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
      expect(prisma.webhookEndpoint.findMany).not.toHaveBeenCalled();
      expect(prisma.webhookEndpoint.findFirst).not.toHaveBeenCalled();
      expect(prisma.webhookEndpoint.update).not.toHaveBeenCalled();
    }

    it('create memakai tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.webhookEndpoint.create.mockResolvedValue({ id: 'w1' });
      const repository = new WebhookRepository(prisma);

      const result = await withTx(tx, () =>
        repository.create({
          userId: 'u1',
          tenantId: 'tenant-1',
          url: 'https://example.com/hook',
          encryptedSecret: 'enc',
          eventTypes: ['event.created'],
        })
      );

      expect(tx.webhookEndpoint.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          tenantId: 'tenant-1',
          url: 'https://example.com/hook',
          secret: 'enc',
          eventTypes: ['event.created'],
        },
      });
      expect(result).toEqual({ id: 'w1' });
      expectPrismaUntouched(prisma);
    });

    it('findManyForUser memakai tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.webhookEndpoint.findMany.mockResolvedValue([{ id: 'w1' }]);
      const repository = new WebhookRepository(prisma);

      const result = await withTx(tx, () => repository.findManyForUser('u1'));

      expect(tx.webhookEndpoint.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual([{ id: 'w1' }]);
      expectPrismaUntouched(prisma);
    });

    it('findByIdForUser memakai tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.webhookEndpoint.findFirst.mockResolvedValue({ id: 'w1' });
      const repository = new WebhookRepository(prisma);

      const result = await withTx(tx, () => repository.findByIdForUser('w1', 'u1'));

      expect(tx.webhookEndpoint.findFirst).toHaveBeenCalledWith({
        where: { id: 'w1', userId: 'u1' },
      });
      expect(result).toEqual({ id: 'w1' });
      expectPrismaUntouched(prisma);
    });

    it('revoke memakai tx', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.webhookEndpoint.update.mockResolvedValue({ id: 'w1', active: false });
      const repository = new WebhookRepository(prisma);

      await withTx(tx, () => repository.revoke('w1'));

      expect(tx.webhookEndpoint.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: { active: false, revokedAt: expect.any(Date) },
      });
      expectPrismaUntouched(prisma);
    });

    it('findActiveByEventType memakai tx (jalur trigger)', async () => {
      const prisma = createMockPrisma();
      const tx = createMockTx();
      tx.webhookEndpoint.findMany.mockResolvedValue([{ id: 'w1' }]);
      const repository = new WebhookRepository(prisma);

      const result = await withTx(tx, () =>
        repository.findActiveByEventType('event.created', 'tenant-1')
      );

      expect(tx.webhookEndpoint.findMany).toHaveBeenCalledWith({
        where: {
          active: true,
          eventTypes: { has: 'event.created' },
          tenantId: 'tenant-1',
        },
      });
      expect(result).toEqual([{ id: 'w1' }]);
      expectPrismaUntouched(prisma);
    });
  });
});
