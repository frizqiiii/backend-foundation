import { z } from 'zod';

/**
 * Union literal lokal untuk kategori & status produk — SENGAJA tidak
 * diimpor dari `@prisma/client` (`ProductCategory`/`ProductStatus`
 * enum hasil generate), mengikuti pola yang sama seperti `RoleName`
 * di `shared/types/role.ts`: Service/Controller tidak perlu tahu
 * detail tipe hasil generate ORM; hanya Repository yang bicara
 * langsung dengan tipe Prisma. Nilai di sini harus tetap identik
 * dengan enum di `schema.prisma`.
 */
export const PRODUCT_CATEGORIES = ['STANDARD', 'FEATURED', 'PREMIUM'] as const;
export type ProductCategoryName = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_STATUSES = ['ACTIVE', 'INACTIVE', 'SOLD'] as const;
export type ProductStatusName = (typeof PRODUCT_STATUSES)[number];

/**
 * Urutan tingkatan kategori — dipakai untuk memvalidasi bahwa upgrade
 * hanya boleh naik, tidak boleh turun atau lompat ke kategori yang
 * sama. Lihat `ProductService.upgradeProduct`.
 */
export const PRODUCT_CATEGORY_RANK: Record<ProductCategoryName, number> = {
  STANDARD: 0,
  FEATURED: 1,
  PREMIUM: 2,
};

/**
 * Skema validasi input untuk membuat produk.
 * `userId` SENGAJA tidak ada di sini — ia bukan input dari client,
 * melainkan diekstrak oleh Controller dari `req.user.id` (hasil
 * `authMiddleware`), agar user tidak bisa membuat produk atas nama
 * user lain hanya dengan memanipulasi body request.
 *
 * `category`/`status` sengaja tidak bisa diisi saat pembuatan —
 * produk baru selalu mulai dari STANDARD/ACTIVE (default skema);
 * menaikkan kategori hanya lewat endpoint upgrade khusus, dengan
 * validasi & pencatatan log yang tidak dilewati.
 */
export const createProductSchema = z.object({
  title: z.string().min(3, 'Judul minimal 3 karakter'),
  description: z.string().min(10, 'Deskripsi minimal 10 karakter'),
  price: z
    .number({ invalid_type_error: 'Harga harus berupa angka' })
    .int('Harga harus bilangan bulat')
    .nonnegative('Harga tidak boleh negatif'),
  stock: z.number().int().nonnegative('Stok tidak boleh negatif').default(1),
});

export type CreateProductDto = z.infer<typeof createProductSchema>;

/**
 * Skema validasi input untuk upgrade kategori produk.
 * `toCategory` dibatasi ke `FEATURED`/`PREMIUM` saja (bukan seluruh
 * `PRODUCT_CATEGORIES`) — `STANDARD` adalah tingkat terendah, tidak
 * masuk akal jadi TUJUAN upgrade.
 */
export const upgradeProductSchema = z.object({
  toCategory: z.enum(['FEATURED', 'PREMIUM'], {
    errorMap: () => ({ message: 'Kategori tujuan harus FEATURED atau PREMIUM' }),
  }),
});

export type UpgradeProductDto = z.infer<typeof upgradeProductSchema>;

/**
 * Skema query untuk listing produk (Phase 8 — sebelumnya
 * `GET /products` mengembalikan SELURUH baris tanpa batas, sekarang
 * dipaginasi + bisa difilter `status`/`category`; kombinasi keduanya
 * persis kolom yang dipakai composite index `[status, category]` di
 * `schema.prisma`).
 */
export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(PRODUCT_STATUSES).optional(),
  category: z.enum(PRODUCT_CATEGORIES).optional(),
});

export type ListProductsQueryDto = z.infer<typeof listProductsQuerySchema>;

/**
 * Shape data produk yang dikembalikan ke client.
 */
export interface ProductResponseDto {
  id: string;
  title: string;
  description: string;
  price: number;
  category: ProductCategoryName;
  status: ProductStatusName;
  stock: number;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}
