import type { PrismaClient, WebhookEndpoint } from '@prisma/client';

export class WebhookRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    userId: string;
    tenantId: string | null;
    url: string;
    encryptedSecret: string;
    eventTypes: string[];
  }): Promise<WebhookEndpoint> {
    return this.prisma.webhookEndpoint.create({
      data: {
        userId: data.userId,
        tenantId: data.tenantId,
        url: data.url,
        secret: data.encryptedSecret,
        eventTypes: data.eventTypes,
      },
    });
  }

  async findManyForUser(userId: string): Promise<WebhookEndpoint[]> {
    return this.prisma.webhookEndpoint.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByIdForUser(id: string, userId: string): Promise<WebhookEndpoint | null> {
    return this.prisma.webhookEndpoint.findFirst({ where: { id, userId } });
  }

  async revoke(id: string): Promise<WebhookEndpoint> {
    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: { active: false, revokedAt: new Date() },
    });
  }

  /**
   * Dipakai `WebhookService.trigger` — SELURUH endpoint AKTIF yang
   * terdaftar untuk `eventType` ini, opsional di-scope ke tenant
   * tertentu (Phase 11) kalau tenant context aktif saat event
   * terjadi. `eventTypes` array — `has` adalah operator Prisma untuk
   * "array kolom ini mengandung nilai X", BUKAN "array parameter ini
   * mengandung X" (arah sebaliknya).
   */
  async findActiveByEventType(
    eventType: string,
    tenantId: string | null
  ): Promise<WebhookEndpoint[]> {
    return this.prisma.webhookEndpoint.findMany({
      where: {
        active: true,
        eventTypes: { has: eventType },
        ...(tenantId ? { tenantId } : {}),
      },
    });
  }
}
