import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { EventRepository } from './event.repository';
import { EventService } from './event.service';
import { EventController } from './event.controller';
import { AuditRepository } from '../audit/audit.repository';
import { AuditService } from '../audit/audit.service';

/**
 * Composition root untuk modul `events`.
 */
const eventRepository = new EventRepository(prisma);
const eventService = new EventService(eventRepository);
const auditService = new AuditService(new AuditRepository(prisma));
const eventController = new EventController(eventService, auditService);

export const eventRouter = Router();

// Rute publik — siapa pun (termasuk tanpa login) boleh melihat event.
eventRouter.get('/', asyncHandler(eventController.list));
// WAJIB didaftarkan SEBELUM `/:id` di bawah — Express mencocokkan
// route berurutan, `/export` akan tertangkap sebagai `:id === "export"`
// kalau urutannya terbalik.
eventRouter.get(
  '/export',
  authMiddleware,
  requirePermission('event.read'),
  asyncHandler(eventController.export)
);
eventRouter.get('/:id', asyncHandler(eventController.getById));

// Phase 7: `requirePermission('event.create')` MENGGANTIKAN
// `requireRole('ORGANIZER', 'ADMIN')` yang dipakai sebelumnya — hasil
// akhirnya EKUIVALEN saat ini (lihat `shared/security/permissions.ts`:
// hanya ORGANIZER & ADMIN yang punya `event.create`), tapi otorisasi
// di sini sekarang menyatakan KAPABILITAS yang dibutuhkan, bukan
// daftar role yang di-hardcode di setiap route file — kalau suatu
// saat aturannya berubah (mis. role baru ikut boleh membuat event),
// cukup ubah satu tempat di `permissions.ts`, tidak perlu menyisir
// ulang setiap route.
eventRouter.post(
  '/',
  authMiddleware,
  requirePermission('event.create'),
  asyncHandler(eventController.create)
);

// Update/delete terbuka untuk siapa pun yang login — otorisasi
// kepemilikan (pemilik event ATAU admin) ditegakkan di EventService,
// bukan di sini, karena butuh tahu data event spesifiknya dulu.
eventRouter.patch('/:id', authMiddleware, asyncHandler(eventController.update));
eventRouter.delete('/:id', authMiddleware, asyncHandler(eventController.remove));
