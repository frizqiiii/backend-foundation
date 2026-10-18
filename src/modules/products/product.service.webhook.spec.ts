import type { Product } from '@prisma/client';
import { ProductService } from './product.service';
import type { ProductRepository } from './product.repository';
import { BadRequestError, ForbiddenError } from '../../shared/utils/http-error';

/**
 * R20 — ProductService memicu webhook setelah operasi bisnis BERHASIL, dan hanya itu.
 */
describe('ProductService memicu webhook (R20)', () => {
  const ownerId = 'user-123';
  const dbProduct: Product = {
    id: 'product-123',
    title: 'Keyboard Mekanik',
    description: 'Keyboard mekanik dengan switch blue, backlit RGB',
    price: 750000,
    category: 'STANDARD',
    status: 'ACTIVE',
    stock: 5,
    userId: ownerId,
    tenantId: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  let repo: jest.Mocked<ProductRepository>;
  let trigger: jest.Mock;
  let service: ProductService;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      applyUpgrade: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<ProductRepository>;
    trigger = jest.fn().mockResolvedValue(undefined);
    service = new ProductService(repo, { trigger });
  });

  it('createProduct: memicu product.created dengan payload yang SAMA dengan response API', async () => {
    repo.create.mockResolvedValue(dbProduct);

    const result = await service.createProduct(
      { title: dbProduct.title, description: dbProduct.description, price: 750000, stock: 5 },
      ownerId
    );

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith('product.created', { ...result });
  });

  it('createProduct: validasi gagal (harga negatif) TIDAK memicu webhook', async () => {
    await expect(
      service.createProduct({ title: 't', description: 'd', price: -1, stock: 1 }, ownerId)
    ).rejects.toThrow(BadRequestError);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('upgradeProduct: memicu product.upgraded dengan data hasil upgrade', async () => {
    repo.findById.mockResolvedValue(dbProduct);
    repo.applyUpgrade.mockResolvedValue({ ...dbProduct, category: 'FEATURED' });

    await service.upgradeProduct(
      dbProduct.id,
      { toCategory: 'FEATURED' },
      { id: ownerId, role: 'USER' }
    );

    expect(trigger).toHaveBeenCalledWith(
      'product.upgraded',
      expect.objectContaining({ id: dbProduct.id, category: 'FEATURED' })
    );
  });

  it('upgradeProduct: ditolak (bukan pemilik) TIDAK memicu webhook', async () => {
    repo.findById.mockResolvedValue(dbProduct);

    await expect(
      service.upgradeProduct(
        dbProduct.id,
        { toCategory: 'FEATURED' },
        { id: 'stranger', role: 'USER' }
      )
    ).rejects.toThrow(ForbiddenError);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('deleteProduct: memicu product.deleted hanya dengan id (tanpa data produk)', async () => {
    repo.findById.mockResolvedValue(dbProduct);

    await service.deleteProduct(dbProduct.id, { id: ownerId, role: 'USER' });

    expect(trigger).toHaveBeenCalledWith('product.deleted', { id: dbProduct.id });
  });

  it('deleteProduct: ditolak (bukan pemilik) TIDAK memicu webhook', async () => {
    repo.findById.mockResolvedValue(dbProduct);

    await expect(
      service.deleteProduct(dbProduct.id, { id: 'stranger', role: 'USER' })
    ).rejects.toThrow(ForbiddenError);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('kegagalan webhook TIDAK menggagalkan operasi bisnis', async () => {
    repo.create.mockResolvedValue(dbProduct);
    trigger.mockRejectedValue(new Error('webhook down'));

    await expect(
      service.createProduct(
        { title: dbProduct.title, description: dbProduct.description, price: 750000, stock: 5 },
        ownerId
      )
    ).resolves.toMatchObject({ id: dbProduct.id });
  });

  it('tanpa webhook terpasang (konstruktor lama) tetap berfungsi', async () => {
    repo.create.mockResolvedValue(dbProduct);
    const plain = new ProductService(repo);

    await expect(
      plain.createProduct(
        { title: dbProduct.title, description: dbProduct.description, price: 750000, stock: 5 },
        ownerId
      )
    ).resolves.toMatchObject({ id: dbProduct.id });
  });
});
