import type { PrismaClient, Tenant } from '@prisma/client';
import type { TenantPlanName } from '../../shared/security/rate-limit-tiers';

/**
 * Repository Layer untuk `Tenant` — pola identik dengan
 * `FeatureFlagRepository`/`ProductRepository`: hanya bertanggung jawab
 * atas akses data, tidak ada logika bisnis (validasi status, resolusi
 * dari header, dsb — itu tugas `TenantService`).
 */
export class TenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * `findFirst`, BUKAN `findUnique` — sama alasannya seperti
   * `ProductRepository.findById`: kondisi tambahan (`deletedAt: null`)
   * tidak bisa digabung ke `findUnique`. Tenant yang sudah di-soft-
   * delete harus berhenti bisa di-resolve oleh `tenantMiddleware`,
   * persis seolah baris ini benar-benar tidak ada lagi.
   */
  async findBySlug(slug: string): Promise<Tenant | null> {
    return this.prisma.tenant.findFirst({ where: { slug, deletedAt: null } });
  }

  async findById(id: string): Promise<Tenant | null> {
    return this.prisma.tenant.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * P3 (Database Audit) — dipaginasi (Phase 8 sudah menerapkan pola
   * ini ke Users/Products/Events; Tenants sebelumnya masih
   * mengembalikan SELURUH baris tanpa batas, tidak konsisten). Jumlah
   * tenant biasanya jauh lebih kecil dari Users/Products/Events, tapi
   * tidak ada jaminan itu akan tetap benar selamanya — konsistensi
   * konvensi lebih penting daripada asumsi "tabelnya pasti selalu
   * kecil". `findMany` + `count` dibungkus `$transaction` (pola yang
   * sama dengan repository lain) agar `total` selalu sinkron dengan
   * `data` dari snapshot yang sama.
   */
  async findMany(params: {
    skip: number;
    take: number;
  }): Promise<{ data: Tenant[]; total: number }> {
    const where = { deletedAt: null };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.tenant.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.tenant.count({ where }),
    ]);
    return { data, total };
  }

  async create(data: { slug: string; name: string; plan?: TenantPlanName }): Promise<Tenant> {
    return this.prisma.tenant.create({ data });
  }

  /**
   * Fase 2 (item 2.11) — SENGAJA hanya mengubah `plan` (bukan `update`
   * generik): update/suspend `status` tenant masih sengaja ditunda
   * (implikasi ke sesi user aktif belum dirancang, lihat
   * `tenant.controller.ts`), sedangkan mengganti plan cuma mengubah
   * angka kuota rate limit — tidak ada sesi yang perlu dicabut.
   */
  async updatePlan(id: string, plan: TenantPlanName): Promise<Tenant> {
    return this.prisma.tenant.update({ where: { id }, data: { plan } });
  }

  /**
   * Soft delete — konsisten dengan konvensi `ProductRepository.delete`
   * dkk: tenant yang "dihapus" TIDAK dihapus fisik supaya
   * User/Product/Event yang masih merujuk `tenantId`-nya (lewat
   * `onDelete: SetNull` di FK) punya jejak forensik yang jelas tenant
   * mana yang tadinya memiliki data tersebut.
   */
  async softDelete(id: string): Promise<Tenant> {
    return this.prisma.tenant.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
