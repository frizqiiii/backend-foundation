import type { PrismaClient, Product, Prisma } from '@prisma/client';
import { pagination } from '../../shared/pagination';
import { getTenantContext, getScopedPrisma } from '../../shared/tenant/tenant-context';
import type { ProductCategoryName, ListProductsQueryDto } from './product.dto';

/**
 * Repository Layer — HANYA bertanggung jawab atas akses data (query
 * Prisma), persis pola yang sama seperti `UserRepository`.
 *
 * Fase 4 (RLS) — REFERENCE IMPLEMENTATION untuk pola `getScopedPrisma`
 * yang perlu diterapkan bertahap ke repository tenant-scoped lain
 * (`EventRepository`, `ApiKeyRepository`, `WebhookEndpointRepository`,
 * `ExportJobRepository` — lihat checklist di
 * docs/tenant-migration-strategy.md).
 */
export class ProductRepository {
  /**
   * Phase 14 (Enterprise Scalability) — `prismaRead` OPSIONAL, default
   * ke `prisma` (primary) yang sama kalau tidak dioper. Ini REFERENCE
   * IMPLEMENTATION untuk pola read-replica routing yang bisa
   * diterapkan bertahap ke repository read-heavy lain — HANYA method
   * BACA murni (`findMany` di bawah) yang memakai `this.prismaRead`;
   * `create`/`update`/`delete` TETAP memakai `this.prisma` (primary)
   * karena WAJIB melihat data paling baru & konsisten. Lihat komentar
   * lengkap trade-off replication lag di `DATABASE_REPLICA_URL`
   * (`env.ts`) sebelum menerapkan pola ini ke repository lain.
   *
   * Fase 4 (RLS) — `prismaRead` SENGAJA BELUM ikut dilindungi RLS di
   * iterasi ini (read-replica adalah koneksi/server FISIK terpisah
   * dari primary, tidak bisa ikut transaksi `$transaction` yang sama
   * dengan `prisma` primary — butuh desain policy/transaksi read-only
   * TERPISAH). `findMany` di bawah TETAP mengandalkan filter aplikasi
   * manual (`where.tenantId`) seperti sebelum Fase 4 — dicatat sebagai
   * gap yang diketahui & disengaja, BUKAN celah yang terlewat, di
   * docs/tenant-migration-strategy.md.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly prismaRead: PrismaClient = prisma
  ) {}

  /**
   * Phase 11 — `tenantId` diisi OTOMATIS dari tenant context aktif
   * (bukan parameter yang wajib dioper Controller/Service), sama pola
   * seperti `findMany`: request tanpa header tenant tetap membuat
   * produk seperti sebelum Phase 11 (`tenantId: null`), tidak error.
   *
   * Fase 4 (RLS) — dipanggil lewat `getScopedPrisma(this.prisma)`:
   * kalau tenant context aktif, INSERT ini jalan di dalam transaksi
   * request (`tx`) yang sudah membawa `app.tenant_id`, jadi `WITH CHECK`
   * policy di migration RLS ikut menegakkan `tenantId` yang dikirim
   * memang cocok dengan tenant aktif — pertahanan berlapis di atas
   * filter aplikasi ini sendiri.
   */
  async create(data: {
    title: string;
    description: string;
    price: number;
    stock: number;
    userId: string;
  }): Promise<Product> {
    const { tenantId } = getTenantContext();
    return getScopedPrisma(this.prisma).product.create({ data: { ...data, tenantId } });
  }

  /**
   * Phase 8 query optimization — MENGGANTIKAN `findAll()` lama yang
   * mengambil SELURUH baris tanpa batas sama sekali (masalah nyata:
   * tabel produk yang bertumbuh besar akan membuat query ini makin
   * lambat & memori response makin besar tanpa batas). Sekarang
   * dipaginasi + bisa difilter `status`/`category`, dan `findMany` +
   * `count` dibungkus `$transaction` (sama seperti
   * `EventRepository.findMany`) agar `total` selalu sinkron dengan
   * `data` dari snapshot yang sama.
   *
   * Phase 11 — tenant-scoped SECARA OPSIONAL: `where.tenantId` HANYA
   * ditambahkan kalau tenant context sedang aktif (lihat
   * `tenantMiddleware`). Ini REFERENCE IMPLEMENTATION untuk pola yang
   * sama yang perlu diterapkan bertahap ke repository lain
   * (`EventRepository`, dst — lihat
   * `docs/tenant-migration-strategy.md`).
   *
   * SENGAJA opsional, bukan wajib — kalau request datang TANPA header
   * `X-Tenant-ID` (client lama, mode transisi), query ini harus
   * berperilaku IDENTIK dengan sebelum Phase 11 (melihat SEMUA produk
   * lintas tenant), bukan tiba-tiba kosong karena disangka
   * "tenant kosong = tidak ada apa-apa".
   *
   * Fase 4 (RLS) — method ini TETAP memakai `this.prismaRead` APA
   * ADANYA (BUKAN `getScopedPrisma`) — lihat catatan RLS di komentar
   * constructor di atas untuk alasannya.
   */
  async findMany(query: ListProductsQueryDto): Promise<{ data: Product[]; total: number }> {
    const { tenantId } = getTenantContext();
    const where: Prisma.ProductWhereInput = { deletedAt: null };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.category) {
      where.category = query.category;
    }

    const [data, total] = await this.prismaRead.$transaction([
      this.prismaRead.product.findMany({
        where,
        ...pagination(query.page, query.limit),
        orderBy: { createdAt: 'desc' },
      }),
      this.prismaRead.product.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * `findFirst`, BUKAN `findUnique` — sama seperti alasan di
   * `EventRepository.findById`/`UserRepository.findById`: kondisi
   * tambahan (`deletedAt: null`) tidak bisa digabung ke `findUnique`.
   * WAJIB filter ini (Phase 3) — produk yang sudah di-soft-delete
   * harus berhenti muncul di `findById` sama sekali, termasuk untuk
   * `upgradeProduct` (yang akan menganggapnya `NotFoundError`, persis
   * seolah baris ini benar-benar tidak ada).
   *
   * Tenant-scoped SECARA OPSIONAL di level APLIKASI (pola & alasan
   * IDENTIK dengan `findMany`), DITAMBAH pertahanan RLS di level
   * DATABASE lewat `getScopedPrisma` (Fase 4) — kalau tenant context
   * aktif, method ini otomatis tidak akan pernah melihat baris tenant
   * lain, bahkan kalau (secara hipotetis) filter `where.tenantId` di
   * bawah ini suatu saat terhapus/salah tulis oleh perubahan
   * berikutnya.
   */
  async findById(id: string): Promise<Product | null> {
    const { tenantId } = getTenantContext();
    const where: Prisma.ProductWhereInput = { id, deletedAt: null };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    return getScopedPrisma(this.prisma).product.findFirst({ where });
  }

  /**
   * Menaikkan kategori produk DAN mencatat log audit dalam SATU
   * transaksi database — kalau salah satu gagal (mis. constraint
   * violation saat insert log), update kategori ikut di-rollback.
   * Tanpa `$transaction`, ada celah nyata: kategori produk berubah
   * tapi riwayatnya tidak tercatat (atau sebaliknya).
   *
   * Fase 4 (RLS) — method ini PALING RUMIT untuk dikonversi ke
   * `getScopedPrisma`, karena aslinya memakai `$transaction([...])`
   * (array form) untuk menjamin atomicity DUA operasi. Masalahnya:
   * `Prisma.TransactionClient` (yang dikembalikan `getScopedPrisma`
   * SAAT tenant context aktif) TIDAK PUNYA method `$transaction` sama
   * sekali — Postgres/Prisma tidak mendukung transaksi bersarang.
   *
   * Solusinya, dua jalur berbeda tergantung ada/tidaknya tenant aktif:
   *   - TIDAK ada tenant aktif -> `client` di bawah adalah
   *     `this.prisma` (singleton biasa) -> HARUS tetap dibungkus
   *     `$transaction([...])` manual seperti sebelumnya, supaya dua
   *     operasi ini tetap atomic satu sama lain.
   *   - ADA tenant aktif -> `client` adalah transaction client (`tx`)
   *     milik SATU transaksi yang sudah dibuka `tenantMiddleware`
   *     untuk SELURUH request ini -> dua operasi di bawah cukup
   *     dijalankan BERURUTAN langsung lewat `client` (SUDAH otomatis
   *     atomic terhadap transaksi request yang sama), TIDAK BOLEH
   *     dibungkus `$transaction([...])` lagi (akan error runtime).
   *
   * Cast `as Product['category']` dipakai alih-alih meng-import enum
   * `ProductCategory` dari `@prisma/client` di Service/Controller —
   * hanya Repository (layer ini) yang boleh tahu detail tipe Prisma;
   * nilai `ProductCategoryName` (union literal lokal) dijamin identik
   * dengan member enum di schema.prisma.
   */
  async applyUpgrade(params: {
    productId: string;
    fromCategory: ProductCategoryName;
    toCategory: ProductCategoryName;
    performedById: string;
  }): Promise<Product> {
    const client = getScopedPrisma(this.prisma);
    const logData = {
      productId: params.productId,
      fromCategory: params.fromCategory as Product['category'],
      toCategory: params.toCategory as Product['category'],
      performedById: params.performedById,
    };

    if (client === this.prisma) {
      const [updatedProduct] = await this.prisma.$transaction([
        this.prisma.product.update({
          where: { id: params.productId },
          data: { category: params.toCategory as Product['category'] },
        }),
        this.prisma.productUpgradeLog.create({ data: logData }),
      ]);
      return updatedProduct;
    }

    const updatedProduct = await client.product.update({
      where: { id: params.productId },
      data: { category: params.toCategory as Product['category'] },
    });
    await client.productUpgradeLog.create({ data: logData });
    return updatedProduct;
  }

  /**
   * Soft delete (Phase 3) — sama alasannya seperti
   * `UserRepository.delete`: mengisi `deletedAt`, BUKAN
   * `prisma.product.delete()` fisik, supaya `ProductUpgradeLog` milik
   * produk ini (riwayat upgrade) tidak ikut hilang/rusak referensinya.
   *
   * Fase 4 (RLS) — lewat `getScopedPrisma`: kalau tenant context
   * aktif, `WITH CHECK` policy RLS memastikan update ini TIDAK BISA
   * menembus baris tenant lain walau (secara hipotetis) `id` yang
   * dioper berasal dari input yang salah/dimanipulasi.
   */
  async delete(id: string): Promise<Product> {
    return getScopedPrisma(this.prisma).product.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
