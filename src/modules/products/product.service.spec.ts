import { ProductService } from './product.service';
import type { RequesterContext } from './product.service';
import type { ProductRepository } from './product.repository';
import type { Product } from '@prisma/client';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/utils/http-error';

describe('ProductService', () => {
  let productService: ProductService;
  let productRepository: jest.Mocked<ProductRepository>;

  const ownerId = 'user-123';
  /**
   * Diketik eksplisit sebagai `Product` (bukan dibiarkan inferred) —
   * SEBELUMNYA dugaan saya salah: saya kira `category: 'STANDARD'`
   * dan `status: 'ACTIVE'` otomatis ter-narrow benar ke enum
   * `ProductCategory`/`ProductStatus` lewat contextual typing di
   * setiap titik pemanggilan `mockResolvedValue(dbProduct)` — TERNYATA
   * TIDAK, karena `dbProduct` sudah jadi variabel `const` duluan
   * (bukan literal langsung di parameter), jadi TypeScript men-widen
   * keduanya jadi `string` biasa. Baru ketahuan dari evidence `tsc`
   * sungguhan (bukan asumsi) — dengan tipe eksplisit di sini, dicek
   * SATU tempat, bukan di 14 titik pemanggilan yang tersebar.
   */
  const dbProduct: Product = {
    id: 'product-123',
    title: 'Keyboard Mekanik',
    description: 'Keyboard mekanik dengan switch blue, backlit RGB',
    price: 750000,
    category: 'STANDARD',
    status: 'ACTIVE',
    stock: 5,
    userId: ownerId,
    // Phase 11 (tenant isolation) — sama seperti event.service.spec.ts,
    // fixture ini dibuat sebelum kolom ini ada di schema.
    tenantId: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    productRepository = {
      create: jest.fn(),
      findMany: jest.fn(),
      findById: jest.fn(),
      applyUpgrade: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<ProductRepository>;

    productService = new ProductService(productRepository);
  });

  describe('createProduct', () => {
    const createInput = {
      title: 'Keyboard Mekanik',
      description: 'Keyboard mekanik dengan switch blue, backlit RGB',
      price: 750000,
      stock: 5,
    };

    it('berhasil membuat produk baru ketika input valid dan user terautentikasi', async () => {
      productRepository.create.mockResolvedValue(dbProduct);

      const result = await productService.createProduct(createInput, ownerId);

      // userId yang dipakai HARUS berasal dari parameter (hasil authMiddleware),
      // bukan dari body — memastikan tidak ada celah user membuat produk
      // atas nama orang lain.
      expect(productRepository.create).toHaveBeenCalledWith({
        title: createInput.title,
        description: createInput.description,
        price: createInput.price,
        stock: createInput.stock,
        userId: ownerId,
      });

      expect(result).toEqual({
        id: dbProduct.id,
        title: dbProduct.title,
        description: dbProduct.description,
        price: dbProduct.price,
        category: dbProduct.category,
        status: dbProduct.status,
        stock: dbProduct.stock,
        userId: dbProduct.userId,
        createdAt: dbProduct.createdAt,
        updatedAt: dbProduct.updatedAt,
      });
    });

    it('melempar BadRequestError ketika harga negatif', async () => {
      const invalidInput = { ...createInput, price: -1000 };

      await expect(productService.createProduct(invalidInput, ownerId)).rejects.toThrow(
        BadRequestError
      );

      // Repository sama sekali tidak boleh dipanggil jika validasi bisnis gagal.
      expect(productRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('listProducts', () => {
    const query = { page: 1, limit: 20 };

    it('berhasil mengambil dan mengembalikan daftar produk terpaginasi', async () => {
      const secondDbProduct = {
        ...dbProduct,
        id: 'product-456',
        title: 'Mouse Wireless',
        price: 250000,
      };
      productRepository.findMany.mockResolvedValue({
        data: [dbProduct, secondDbProduct],
        total: 2,
      });

      const result = await productService.listProducts(query);

      expect(productRepository.findMany).toHaveBeenCalledWith(query);
      expect(result.data).toHaveLength(2);
      expect(result.data).toEqual([
        expect.objectContaining({ id: dbProduct.id, title: dbProduct.title }),
        expect.objectContaining({ id: secondDbProduct.id, title: secondDbProduct.title }),
      ]);
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });

    it('mengembalikan data kosong (bukan error) ketika belum ada produk sama sekali', async () => {
      productRepository.findMany.mockResolvedValue({ data: [], total: 0 });

      const result = await productService.listProducts(query);

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
    });

    it('meneruskan filter status/category apa adanya ke repository', async () => {
      productRepository.findMany.mockResolvedValue({ data: [], total: 0 });
      const filteredQuery = { page: 1, limit: 20, status: 'ACTIVE', category: 'FEATURED' } as const;

      await productService.listProducts(filteredQuery);

      expect(productRepository.findMany).toHaveBeenCalledWith(filteredQuery);
    });
  });

  describe('upgradeProduct', () => {
    const upgradeInput = { toCategory: 'FEATURED' } as const;
    const ownerRequester: RequesterContext = { id: ownerId, role: 'USER' };
    const adminRequester: RequesterContext = { id: 'admin-999', role: 'ADMIN' };

    it('berhasil upgrade ketika requester adalah pemilik, status ACTIVE, dan stok tersedia', async () => {
      productRepository.findById.mockResolvedValue(dbProduct);
      productRepository.applyUpgrade.mockResolvedValue({ ...dbProduct, category: 'FEATURED' });

      const result = await productService.upgradeProduct(
        dbProduct.id,
        upgradeInput,
        ownerRequester
      );

      expect(productRepository.applyUpgrade).toHaveBeenCalledWith({
        productId: dbProduct.id,
        fromCategory: 'STANDARD',
        toCategory: 'FEATURED',
        performedById: ownerId,
      });
      expect(result.category).toBe('FEATURED');
    });

    it('berhasil upgrade ketika requester ADMIN meski bukan pemilik', async () => {
      productRepository.findById.mockResolvedValue(dbProduct);
      productRepository.applyUpgrade.mockResolvedValue({ ...dbProduct, category: 'FEATURED' });

      const result = await productService.upgradeProduct(
        dbProduct.id,
        upgradeInput,
        adminRequester
      );

      expect(result.category).toBe('FEATURED');
    });

    it('melempar NotFoundError ketika produk tidak ditemukan', async () => {
      productRepository.findById.mockResolvedValue(null);

      await expect(
        productService.upgradeProduct('unknown-id', upgradeInput, ownerRequester)
      ).rejects.toThrow(NotFoundError);
      expect(productRepository.applyUpgrade).not.toHaveBeenCalled();
    });

    it('melempar ForbiddenError ketika requester BUKAN pemilik dan BUKAN admin', async () => {
      productRepository.findById.mockResolvedValue(dbProduct);

      await expect(
        productService.upgradeProduct(dbProduct.id, upgradeInput, {
          id: 'another-user-id',
          role: 'USER',
        })
      ).rejects.toThrow(ForbiddenError);
      expect(productRepository.applyUpgrade).not.toHaveBeenCalled();
    });

    it('melempar BadRequestError ketika produk berstatus bukan ACTIVE', async () => {
      productRepository.findById.mockResolvedValue({ ...dbProduct, status: 'SOLD' });

      await expect(
        productService.upgradeProduct(dbProduct.id, upgradeInput, ownerRequester)
      ).rejects.toThrow(BadRequestError);
      expect(productRepository.applyUpgrade).not.toHaveBeenCalled();
    });

    it('melempar BadRequestError ketika stok habis', async () => {
      productRepository.findById.mockResolvedValue({ ...dbProduct, stock: 0 });

      await expect(
        productService.upgradeProduct(dbProduct.id, upgradeInput, ownerRequester)
      ).rejects.toThrow(BadRequestError);
      expect(productRepository.applyUpgrade).not.toHaveBeenCalled();
    });

    it('melempar BadRequestError ketika kategori tujuan bukan tingkatan yang lebih tinggi', async () => {
      productRepository.findById.mockResolvedValue({ ...dbProduct, category: 'PREMIUM' });

      await expect(
        productService.upgradeProduct(dbProduct.id, upgradeInput, ownerRequester) // target FEATURED < current PREMIUM
      ).rejects.toThrow(BadRequestError);
      expect(productRepository.applyUpgrade).not.toHaveBeenCalled();
    });
  });

  describe('deleteProduct', () => {
    const ownerRequester: RequesterContext = { id: ownerId, role: 'USER' };
    const adminRequester: RequesterContext = { id: 'admin-999', role: 'ADMIN' };
    const strangerRequester: RequesterContext = { id: 'stranger-1', role: 'USER' };

    it('berhasil soft-delete ketika requester adalah pemilik produk', async () => {
      productRepository.findById.mockResolvedValue(dbProduct);

      await productService.deleteProduct(dbProduct.id, ownerRequester);

      expect(productRepository.delete).toHaveBeenCalledWith(dbProduct.id);
    });

    it('berhasil soft-delete ketika requester ADMIN meski bukan pemilik (product.moderate)', async () => {
      productRepository.findById.mockResolvedValue(dbProduct);

      await productService.deleteProduct(dbProduct.id, adminRequester);

      expect(productRepository.delete).toHaveBeenCalledWith(dbProduct.id);
    });

    it('melempar ForbiddenError ketika requester BUKAN pemilik dan tidak punya product.moderate', async () => {
      productRepository.findById.mockResolvedValue(dbProduct);

      await expect(productService.deleteProduct(dbProduct.id, strangerRequester)).rejects.toThrow(
        ForbiddenError
      );
      expect(productRepository.delete).not.toHaveBeenCalled();
    });

    it('melempar NotFoundError ketika produk tidak ditemukan (atau sudah dihapus sebelumnya)', async () => {
      productRepository.findById.mockResolvedValue(null);

      await expect(productService.deleteProduct('unknown-id', ownerRequester)).rejects.toThrow(
        NotFoundError
      );
      expect(productRepository.delete).not.toHaveBeenCalled();
    });
  });
});
