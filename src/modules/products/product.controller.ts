import type { Request, Response } from 'express';
import type { ProductService } from './product.service';
import type { AuditService } from '../audit/audit.service';
import { createProductSchema, upgradeProductSchema, listProductsQuerySchema } from './product.dto';
import { UnauthorizedError } from '../../shared/utils/http-error';
import { sendSuccess } from '../../shared/utils/response';
import { getClientIp, getUserAgent } from '../../shared/utils/request-context';

/**
 * Controller Layer — HANYA HTTP concerns, pola yang sama seperti
 * `UserController`.
 */
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly auditService: AuditService
  ) {}

  /**
   * `req.user` dipastikan terisi oleh `authMiddleware` (lihat
   * product.routes.ts — rute ini diproteksi). `userId` TIDAK diambil
   * dari body request agar user tidak bisa membuat produk atas nama
   * user lain.
   */
  create = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const input = createProductSchema.parse(req.body);
    const product = await this.productService.createProduct(input, req.user.id);

    await this.auditService.logCreate('Product', product.id, {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, 201, 'Produk berhasil dibuat', product);
  };

  /**
   * Phase 8 — sebelumnya mengembalikan SELURUH produk tanpa batas.
   * `query` divalidasi Zod (`listProductsQuerySchema`) sama seperti
   * pola pagination di modul `events`; metadata pagination dikirim
   * lewat parameter `meta`, terpisah dari `data`.
   */
  findAll = async (req: Request, res: Response): Promise<void> => {
    const query = listProductsQuerySchema.parse(req.query);
    const result = await this.productService.listProducts(query);

    sendSuccess(res, 200, 'Daftar produk berhasil diambil', result.data, result.meta);
  };

  /**
   * Otorisasi kepemilikan (pemilik ATAU admin) serta seluruh validasi
   * bisnis (status, stok, urutan kategori) ditegakkan di
   * `ProductService.upgradeProduct`, bukan di sini — Controller hanya
   * meneruskan identitas requester. Dicatat sebagai audit `UPDATE`
   * (bukan aksi terpisah) — upgrade tetap sebuah perubahan state pada
   * baris Product yang sudah ada, bukan penciptaan baris baru.
   */
  upgrade = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const input = upgradeProductSchema.parse(req.body);
    const product = await this.productService.upgradeProduct(req.params.id, input, req.user);

    await this.auditService.logUpdate('Product', product.id, {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, 200, 'Produk berhasil di-upgrade', product);
  };

  /**
   * Otorisasi kepemilikan (pemilik ATAU admin) ditegakkan di
   * `ProductService.deleteProduct`, bukan di sini — Controller hanya
   * meneruskan identitas requester, pola sama seperti
   * `EventController.remove`.
   */
  remove = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.productService.deleteProduct(req.params.id, req.user);

    await this.auditService.logDelete('Product', req.params.id, {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, 200, 'Produk berhasil dihapus', null);
  };
}
