import type { PrismaClient, WebhookEndpoint } from '@prisma/client';
import {
  getScopedPrisma,
  getTenantContext,
  runInTenantTransaction,
} from '../../shared/tenant/tenant-context';

/**
 * R18 — `webhook_endpoints` ber-FORCE RLS. Semua query lewat `getScopedPrisma(this.prisma)`: kalau request
 * membawa konteks tenant (`tenantMiddleware`), query berjalan di transaksi yang sudah `set_config('app.tenant_id')`.
 * Memakai `this.prisma` langsung = koneksi tanpa tenant -> `create` ditolak 42501 (500) dan `findMany` kosong.
 * Tanpa konteks tenant (mis. proses di luar request) hasilnya fail-closed: kosong / INSERT ditolak.
 */
export class WebhookRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    userId: string;
    tenantId: string | null;
    url: string;
    encryptedSecret: string;
    eventTypes: string[];
  }): Promise<WebhookEndpoint> {
    return getScopedPrisma(this.prisma).webhookEndpoint.create({
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
    return getScopedPrisma(this.prisma).webhookEndpoint.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByIdForUser(id: string, userId: string): Promise<WebhookEndpoint | null> {
    return getScopedPrisma(this.prisma).webhookEndpoint.findFirst({ where: { id, userId } });
  }

  async revoke(id: string): Promise<WebhookEndpoint> {
    return getScopedPrisma(this.prisma).webhookEndpoint.update({
      where: { id },
      data: { active: false, revokedAt: new Date() },
    });
  }

  /**
   * Dipakai `WebhookService.trigger` — SELURUH endpoint AKTIF milik tenant AKTIF yang terdaftar untuk `eventType`.
   *
   * R20 — tenant SELALU diambil dari konteks (bukan parameter), jadi pemanggil tidak bisa meminta tenant lain. Tanpa
   * konteks tenant hasilnya kosong (fail-closed; tabel ber-RLS memang tidak terbaca tanpa `app.tenant_id`).
   *
   * Query berjalan di transaksi MANDIRI (`runInTenantTransaction`, koneksi sendiri), bukan di transaksi request.
   * Alasannya: `trigger` dijalankan tanpa ditunggu (`dispatchWebhook`), jadi bisa masih berjalan saat transaksi request
   * sudah di-commit ("Transaction already closed"), dan query yang gagal di transaksi request akan membuat Postgres
   * membatalkan SELURUH transaksi itu (operasi bisnisnya ikut hilang).
   * `eventTypes: { has }` = "array kolom ini mengandung nilai X" (arah sebaliknya dari yang mungkin terkira).
   */
  async findActiveByEventType(eventType: string): Promise<WebhookEndpoint[]> {
    const { tenantId } = getTenantContext();
    if (!tenantId) {
      return [];
    }
    return runInTenantTransaction(this.prisma, tenantId, () =>
      getScopedPrisma(this.prisma).webhookEndpoint.findMany({
        where: { active: true, eventTypes: { has: eventType }, tenantId },
      })
    );
  }
}
