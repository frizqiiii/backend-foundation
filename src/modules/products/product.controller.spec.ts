import type { Request, Response } from 'express';
import { ProductController } from './product.controller';
import type { ProductService } from './product.service';
import type { AuditService } from '../audit/audit.service';
import { UnauthorizedError } from '../../shared/utils/http-error';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createMockRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    ip: '10.0.0.1',
    get: jest.fn().mockReturnValue('curl/8.0'),
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

describe('ProductController', () => {
  let productService: jest.Mocked<ProductService>;
  let auditService: jest.Mocked<AuditService>;
  let controller: ProductController;

  beforeEach(() => {
    productService = {
      createProduct: jest.fn(),
      listProducts: jest.fn(),
      upgradeProduct: jest.fn(),
      deleteProduct: jest.fn(),
    } as unknown as jest.Mocked<ProductService>;
    auditService = {
      logCreate: jest.fn(),
      logUpdate: jest.fn(),
      logDelete: jest.fn(),
    } as unknown as jest.Mocked<AuditService>;
    controller = new ProductController(productService, auditService);
  });

  describe('create', () => {
    it('membuat produk atas nama req.user.id (BUKAN dari body), mencatat audit CREATE, membalas 201', async () => {
      const req = createMockRequest({
        user: { id: 'user-1' },
        body: { title: 'Meja kayu', description: 'Meja kayu jati kondisi baru', price: 500000 },
      });
      const res = createMockResponse();
      const product = { id: 'product-1', title: 'Meja kayu' };
      productService.createProduct.mockResolvedValue(product as never);

      await controller.create(req, res);

      expect(productService.createProduct).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Meja kayu' }),
        'user-1'
      );
      expect(auditService.logCreate).toHaveBeenCalledWith('Product', 'product-1', {
        userId: 'user-1',
        ipAddress: '10.0.0.1',
        userAgent: 'curl/8.0',
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: product }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada, TIDAK membuat produk apa pun', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow(UnauthorizedError);
      expect(productService.createProduct).not.toHaveBeenCalled();
    });

    it('P5 — body tidak valid (title terlalu pendek) dilempar sebagai error validasi, service tidak dipanggil', async () => {
      const req = createMockRequest({
        user: { id: 'user-1' },
        body: { title: 'ab', description: 'Deskripsi cukup panjang', price: 1000 },
      });
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow();
      expect(productService.createProduct).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('mem-parsing query pagination/filter dan membalas data+meta', async () => {
      const req = createMockRequest({ query: { status: 'ACTIVE', category: 'PREMIUM' } });
      const res = createMockResponse();
      const result = {
        data: [{ id: 'p1' }],
        meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
      };
      productService.listProducts.mockResolvedValue(result as never);

      await controller.findAll(req, res);

      expect(productService.listProducts).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ACTIVE', category: 'PREMIUM', page: 1, limit: 20 })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: result.data, meta: result.meta })
      );
    });
  });

  describe('upgrade', () => {
    it('meneruskan req.user APA ADANYA ke service (otorisasi kepemilikan ditegakkan di Service, bukan Controller), mencatat audit UPDATE (bukan aksi terpisah)', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', role: 'USER' },
        params: { id: 'product-1' },
        body: { toCategory: 'FEATURED' },
      });
      const res = createMockResponse();
      const product = { id: 'product-1', category: 'FEATURED' };
      productService.upgradeProduct.mockResolvedValue(product as never);

      await controller.upgrade(req, res);

      expect(productService.upgradeProduct).toHaveBeenCalledWith(
        'product-1',
        { toCategory: 'FEATURED' },
        { id: 'user-1', role: 'USER' }
      );
      expect(auditService.logUpdate).toHaveBeenCalledWith(
        'Product',
        'product-1',
        expect.objectContaining({ userId: 'user-1' })
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: product }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({
        params: { id: 'product-1' },
        body: { toCategory: 'FEATURED' },
      });
      const res = createMockResponse();

      await expect(controller.upgrade(req, res)).rejects.toThrow(UnauthorizedError);
      expect(productService.upgradeProduct).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('menghapus produk, meneruskan req.user penuh ke service (bukan hanya id), mencatat audit DELETE', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', role: 'ADMIN' },
        params: { id: 'product-1' },
      });
      const res = createMockResponse();

      await controller.remove(req, res);

      expect(productService.deleteProduct).toHaveBeenCalledWith('product-1', {
        id: 'user-1',
        role: 'ADMIN',
      });
      expect(auditService.logDelete).toHaveBeenCalledWith(
        'Product',
        'product-1',
        expect.objectContaining({ userId: 'user-1' })
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada, TIDAK menghapus apa pun', async () => {
      const req = createMockRequest({ params: { id: 'product-1' } });
      const res = createMockResponse();

      await expect(controller.remove(req, res)).rejects.toThrow(UnauthorizedError);
      expect(productService.deleteProduct).not.toHaveBeenCalled();
    });
  });
});
