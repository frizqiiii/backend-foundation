import type { ProductRepository } from './product.repository';
import type {
  CreateProductDto,
  UpgradeProductDto,
  ProductResponseDto,
  ProductCategoryName,
  ProductStatusName,
  ListProductsQueryDto,
} from './product.dto';
import { PRODUCT_CATEGORY_RANK } from './product.dto';
import type { RoleName } from '../../shared/types/role';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/utils/http-error';
import { hasPermission } from '../../shared/security/permissions';
import { getOrSetCache, invalidateByPattern } from '../../shared/utils/cache';
import { cacheKeys } from '../../shared/utils/cache-keys';
import { buildPaginatedResult, type PaginatedResult } from '../../shared/pagination';

const PRODUCTS_LIST_CACHE_TTL_SECONDS = 60;

export interface RequesterContext {
  id: string;
  role: RoleName;
}

/**
 * Service Layer — business logic modul produk.
 *
 * Catatan desain: validasi "harga tidak boleh negatif" sudah dicek di
 * `createProductSchema` (Zod, di boundary HTTP). Pengecekan yang sama
 * tetap diulang di sini sebagai *domain invariant* — aturan bisnis
 * ini harus tetap berlaku meskipun Service dipanggil dari jalur lain
 * di masa depan (job scheduler, event consumer, gRPC) yang tidak
 * lewat validasi HTTP. Service tidak boleh mempercayai input mentah
 * dari layer manapun di atasnya.
 */
export class ProductService {
  constructor(private readonly productRepository: ProductRepository) {}

  async createProduct(input: CreateProductDto, userId: string): Promise<ProductResponseDto> {
    if (input.price < 0) {
      throw new BadRequestError('Harga produk tidak boleh negatif');
    }

    const product = await this.productRepository.create({
      title: input.title,
      description: input.description,
      price: input.price,
      stock: input.stock,
      userId,
    });

    await invalidateByPattern(cacheKeys.productsListPattern());

    return this.toResponseDto(product);
  }

  /**
   * Di-cache 60 detik PER KOMBINASI query (Phase 8 — sebelumnya satu
   * key tunggal untuk seluruh daftar produk tanpa pagination/filter
   * sama sekali; sekarang mengikuti pola yang identik dengan
   * `EventService.listEvents`, termasuk cara invalidasinya lewat
   * `invalidateByPattern` karena satu write tidak bisa tahu kombinasi
   * page/filter mana saja yang terpengaruh).
   */
  async listProducts(query: ListProductsQueryDto): Promise<PaginatedResult<ProductResponseDto>> {
    const queryKey = JSON.stringify(query, Object.keys(query).sort());
    return getOrSetCache(
      cacheKeys.productsList(queryKey),
      PRODUCTS_LIST_CACHE_TTL_SECONDS,
      async () => {
        const { data, total } = await this.productRepository.findMany(query);
        return buildPaginatedResult(
          data.map((product) => this.toResponseDto(product)),
          total,
          query.page,
          query.limit
        );
      }
    );
  }

  /**
   * Upgrade kategori produk (#4) — dengan seluruh syarat berikut
   * ditegakkan SEBELUM menyentuh database, urutan pengecekan sengaja
   * dari yang paling murah/aman ke yang paling mahal (query):
   *
   * 1. Produk harus ada (`NotFoundError`).
   * 2. Requester harus pemilik produk ATAU admin (`ForbiddenError`) —
   *    pola sama seperti otorisasi kepemilikan di Events (#3).
   * 3. Status produk harus ACTIVE — produk INACTIVE/SOLD tidak boleh
   *    di-upgrade (`BadRequestError`).
   * 4. Stok harus lebih dari 0 — tidak masuk akal mem-boost visibilitas
   *    produk yang sudah habis (`BadRequestError`).
   * 5. Kategori tujuan harus LEBIH TINGGI dari kategori saat ini —
   *    mencegah "upgrade" ke kategori yang sama atau lebih rendah
   *    (`BadRequestError`).
   *
   * Setelah semua syarat lolos, perubahan kategori + pencatatan log
   * dilakukan atomik oleh `ProductRepository.applyUpgrade`.
   */
  async upgradeProduct(
    productId: string,
    dto: UpgradeProductDto,
    requester: RequesterContext
  ): Promise<ProductResponseDto> {
    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundError('Produk tidak ditemukan');
    }

    const isOwner = product.userId === requester.id;
    const canModerate = hasPermission(requester.role, 'product.moderate');
    if (!isOwner && !canModerate) {
      throw new ForbiddenError('Anda hanya bisa meng-upgrade produk milik Anda sendiri');
    }

    const currentStatus = product.status as ProductStatusName;
    if (currentStatus !== 'ACTIVE') {
      throw new BadRequestError(
        `Produk berstatus ${currentStatus} tidak bisa di-upgrade. Hanya produk ACTIVE yang bisa di-upgrade.`
      );
    }

    if (product.stock <= 0) {
      throw new BadRequestError('Stok produk habis, tidak bisa di-upgrade');
    }

    const currentCategory = product.category as ProductCategoryName;
    if (PRODUCT_CATEGORY_RANK[dto.toCategory] <= PRODUCT_CATEGORY_RANK[currentCategory]) {
      throw new BadRequestError(
        `Tidak bisa upgrade dari ${currentCategory} ke ${dto.toCategory} — kategori tujuan harus lebih tinggi dari kategori saat ini`
      );
    }

    const upgraded = await this.productRepository.applyUpgrade({
      productId,
      fromCategory: currentCategory,
      toCategory: dto.toCategory,
      performedById: requester.id,
    });

    await invalidateByPattern(cacheKeys.productsListPattern());

    return this.toResponseDto(upgraded);
  }

  /**
   * Soft delete (Phase 3) — otorisasi identik dengan `upgradeProduct`:
   * pemilik produk ATAU requester dengan `product.moderate`
   * (`ForbiddenError` selain itu). TIDAK ada pengecekan status/stok
   * seperti di upgrade — produk apa pun (ACTIVE/INACTIVE/SOLD) boleh
   * dihapus pemiliknya kapan saja.
   */
  async deleteProduct(productId: string, requester: RequesterContext): Promise<void> {
    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundError('Produk tidak ditemukan');
    }

    const isOwner = product.userId === requester.id;
    const canModerate = hasPermission(requester.role, 'product.moderate');
    if (!isOwner && !canModerate) {
      throw new ForbiddenError('Anda hanya bisa menghapus produk milik Anda sendiri');
    }

    await this.productRepository.delete(productId);
    await invalidateByPattern(cacheKeys.productsListPattern());
  }

  private toResponseDto(product: {
    id: string;
    title: string;
    description: string;
    price: number;
    category: string;
    status: string;
    stock: number;
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }): ProductResponseDto {
    return {
      id: product.id,
      title: product.title,
      description: product.description,
      price: product.price,
      category: product.category as ProductCategoryName,
      status: product.status as ProductStatusName,
      stock: product.stock,
      userId: product.userId,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }
}
