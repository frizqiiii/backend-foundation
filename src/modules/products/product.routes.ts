import { Router } from 'express';
import { prisma, prismaRead } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';
import { AuditRepository } from '../audit/audit.repository';
import { AuditService } from '../audit/audit.service';

/**
 * Composition root untuk modul `products` — pola dependency injection
 * manual yang identik dengan `user.routes.ts`. Modul ini terisolasi
 * penuh: satu-satunya titik kopling ke modul `users` adalah lewat
 * `authMiddleware` (shared layer) dan foreign key `userId` di skema
 * Prisma — TIDAK ada import langsung dari `modules/users/*` di sini.
 */
const productRepository = new ProductRepository(prisma, prismaRead);
const productService = new ProductService(productRepository);
const auditService = new AuditService(new AuditRepository(prisma));
const productController = new ProductController(productService, auditService);

export const productRouter = Router();

// Rute publik — siapa pun boleh melihat daftar produk tanpa login.
productRouter.get('/', asyncHandler(productController.findAll));

// Rute terproteksi — hanya user yang login yang bisa membuat produk.
// authMiddleware mengisi req.user, dipakai Controller untuk userId.
productRouter.post('/', authMiddleware, asyncHandler(productController.create));

// Upgrade kategori produk (#4) — otorisasi kepemilikan (pemilik ATAU
// admin) dan seluruh validasi bisnis ditegakkan di ProductService,
// bukan di sini; authMiddleware hanya memastikan requester dikenal.
productRouter.patch('/:id/upgrade', authMiddleware, asyncHandler(productController.upgrade));

// Soft delete (Phase 3) — otorisasi kepemilikan (pemilik ATAU
// requester dengan `product.moderate`) ditegakkan di
// `ProductService.deleteProduct`, sama seperti upgrade di atas.
productRouter.delete('/:id', authMiddleware, asyncHandler(productController.remove));
