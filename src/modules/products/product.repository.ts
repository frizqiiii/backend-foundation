import type { PrismaClient, Product, Prisma } from '@prisma/client';
import { pagination } from '../../shared/pagination';
import { getTenantContext } from '../../shared/tenant/tenant-context';
import type { ProductCategoryName, ListProductsQueryDto } from './product.dto';

/**
 * Repository Layer — HANYA bertanggung jawab atas akses data (query
 * Prisma), persis pola yang sama seperti `UserRepository`.
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
   */
  async create(data: {
    title: string;
    description: string;
    price: number;
    stock: number;
    userId: string;
  }): Promise<Product> {
    const { tenantId } = getTenantContext();
    return this.prisma.product.create({ data: { ...data, tenantId } });
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
   */
  /**
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

    // Phase 14 — `this.prismaRead`, BUKAN `this.prisma`: listing
    // adalah query BACA murni, kandidat ideal untuk read replica
    // (lihat komentar constructor di atas). Kedua panggilan di dalam
    // `$transaction` HARUS memakai client yang SAMA (`prismaRead`) —
    // Prisma `$transaction` array butuh seluruh operasinya berasal
    // dari satu instance client yang sama.
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
   * Tenant-scoped SECARA OPSIONAL — pola & alasan IDENTIK dengan
   * `findMany` di atas (lihat komentarnya): `where.tenantId` hanya
   * ditambahkan kalau tenant context sedang aktif, supaya client
   * lama (tanpa header `X-Tenant-ID`) tetap berperilaku persis
   * seperti sebelum Phase 11. Sebelum perubahan ini, `findById`
   * adalah SATU-SATUNYA method baca di repository ini yang belum
   * ikut tenant-scoped seperti `findMany` — pemanggilnya saat ini
   * (`upgradeProduct`/`deleteProduct`) sudah aman lewat pengecekan
   * `isOwner`/`product.moderate` di Service, jadi ini murni
   * pertahanan berlapis (defense-in-depth) untuk isolasi tenant yang
   * konsisten, bukan menutup celah yang sudah tereksploitasi.
   */
  async findById(id: string): Promise<Product | null> {
    const { tenantId } = getTenantContext();
    const where: Prisma.ProductWhereInput = { id, deletedAt: null };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    return this.prisma.product.findFirst({ where });
  }

  /**
   * Menaikkan kategori produk DAN mencatat log audit dalam SATU
   * transaksi database — kalau salah satu gagal (mis. constraint
   * violation saat insert log), update kategori ikut di-rollback.
   * Tanpa `$transaction`, ada celah nyata: kategori produk berubah
   * tapi riwayatnya tidak tercatat (atau sebaliknya).
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
    const [updatedProduct] = await this.prisma.$transaction([
      this.prisma.product.update({
        where: { id: params.productId },
        data: { category: params.toCategory as Product['category'] },
      }),
      this.prisma.productUpgradeLog.create({
        data: {
          productId: params.productId,
          fromCategory: params.fromCategory as Product['category'],
          toCategory: params.toCategory as Product['category'],
          performedById: params.performedById,
        },
      }),
    ]);

    return updatedProduct;
  }

  /**
   * Soft delete (Phase 3) — sama alasannya seperti
   * `UserRepository.delete`: mengisi `deletedAt`, BUKAN
   * `prisma.product.delete()` fisik, supaya `ProductUpgradeLog` milik
   * produk ini (riwayat upgrade) tidak ikut hilang/rusak referensinya.
   */
  async delete(id: string): Promise<Product> {
    return this.prisma.product.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
