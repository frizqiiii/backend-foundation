import { z } from 'zod';

/**
 * Skema validasi input untuk membuat event.
 * `ownerId` SENGAJA tidak ada di sini — mengikuti pola yang sama
 * seperti `userId` pada `product.dto.ts`: diekstrak dari
 * `req.user.id` (hasil `authMiddleware`) di Controller, bukan dari
 * body request.
 */
export const createEventSchema = z.object({
  title: z.string().min(3, 'Judul minimal 3 karakter'),
  description: z.string().optional(),
  category: z.string().min(1, 'Kategori wajib diisi'),
  location: z.string().min(1, 'Lokasi wajib diisi'),
  date: z.coerce.date({ invalid_type_error: 'Format tanggal tidak valid' }),
});

export type CreateEventDto = z.infer<typeof createEventSchema>;

/**
 * Skema validasi untuk update event — semua field opsional (partial),
 * tapi field yang dikirim tetap harus lolos aturan yang sama seperti
 * saat pembuatan.
 */
export const updateEventSchema = createEventSchema.partial();

export type UpdateEventDto = z.infer<typeof updateEventSchema>;

/**
 * Skema query string untuk `GET /api/events` — pagination, filter
 * (kategori, lokasi, rentang tanggal), dan search (judul).
 *
 * `z.coerce` dipakai karena query string Express selalu berupa string
 * mentah (`req.query.page` adalah `"2"`, bukan `2`) — coerce
 * mengonversi sekaligus memvalidasi dalam satu langkah, alih-alih
 * `Number(req.query.page || 1)` manual yang mudah menghasilkan `NaN`
 * tanpa terdeteksi.
 */
export const listEventsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    search: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    location: z.string().trim().min(1).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
  })
  .refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo, {
    message: 'dateFrom harus sebelum atau sama dengan dateTo',
    path: ['dateFrom'],
  });

export type ListEventsQueryDto = z.infer<typeof listEventsQuerySchema>;

/**
 * Skema query untuk `GET /events/export` (Phase 16 upgrade) — filter
 * SAMA seperti `listEventsQuerySchema`, MINUS `page`/`limit` (export
 * mengambil semua baris yang cocok, bukan satu halaman — lihat
 * `EventService.exportEvents`), PLUS `format`.
 *
 * P5 (Testing) — Finding: `.innerType()` diperlukan untuk bisa
 * `.omit()`/`.extend()` (keduanya tidak ada di `ZodEffects` hasil
 * `.refine()`), TAPI itu juga MELEPAS validasi silang `dateFrom <=
 * dateTo` yang sudah ditegakkan `listEventsQuerySchema` — sebelum
 * perbaikan ini, `GET /events/export?dateFrom=2026-12-31&dateTo=
 * 2026-01-01` diam-diam LOLOS validasi (walau hasilnya kosong, bukan
 * error), padahal endpoint `GET /events` yang setara akan menolaknya
 * dengan 422. Ditemukan lewat test (bukan audit manual) — bukti
 * kenapa P5 (menulis test) juga berfungsi sebagai P3/P2 tambahan.
 * `.refine()` yang sama diterapkan ULANG di sini secara eksplisit
 * supaya kedua endpoint tetap konsisten.
 */
export const exportEventsQuerySchema = listEventsQuerySchema
  .innerType()
  .omit({
    page: true,
    limit: true,
  })
  .extend({
    format: z.enum(['csv', 'xlsx']).default('csv'),
  })
  .refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo, {
    message: 'dateFrom harus sebelum atau sama dengan dateTo',
    path: ['dateFrom'],
  });

export type ExportEventsQueryDto = z.infer<typeof exportEventsQuerySchema>;

/**
 * Shape data event yang dikembalikan ke client.
 */
export interface EventResponseDto {
  id: string;
  title: string;
  description: string | null;
  category: string;
  location: string;
  date: Date;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}
