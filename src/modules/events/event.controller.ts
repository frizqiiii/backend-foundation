import type { Request, Response } from 'express';
import type { EventService } from './event.service';
import type { AuditService } from '../audit/audit.service';
import {
  createEventSchema,
  updateEventSchema,
  listEventsQuerySchema,
  exportEventsQuerySchema,
} from './event.dto';
import type { EventResponseDto } from './event.dto';
import { UnauthorizedError } from '../../shared/utils/http-error';
import { sendSuccess } from '../../shared/utils/response';
import { getClientIp, getUserAgent } from '../../shared/utils/request-context';
import { toCsv, toXlsxBuffer } from '../../shared/utils/export';
import type { ExportColumn } from '../../shared/utils/export';

/**
 * Controller Layer modul `events` — pola yang sama seperti
 * `ProductController`/`UserController`: HANYA HTTP concerns.
 */
export class EventController {
  constructor(
    private readonly eventService: EventService,
    private readonly auditService: AuditService
  ) {}

  /**
   * `req.user` dipastikan terisi (authMiddleware) DAN role-nya sudah
   * dipastikan ORGANIZER/ADMIN (requireRole) sebelum handler ini
   * jalan — lihat `event.routes.ts`. `ownerId` diambil dari token,
   * TIDAK dari body, dengan alasan yang sama seperti `userId` pada
   * Product: mencegah user membuat event atas nama orang lain.
   */
  create = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const input = createEventSchema.parse(req.body);
    const event = await this.eventService.createEvent(input, req.user.id);

    await this.auditService.logCreate('Event', event.id, {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, 201, 'Event berhasil dibuat', event);
  };

  /**
   * Endpoint publik — bisa diakses tanpa login. `query` divalidasi
   * lewat Zod (`listEventsQuerySchema`) sehingga `page`/`limit` yang
   * bukan angka atau `dateFrom` > `dateTo` ditolak sebelum sampai ke
   * Service/Repository. Metadata pagination (`page`, `limit`,
   * `total`, `totalPages`) dikirim lewat parameter `meta` —
   * terpisah dari `data`, bukan dicampur ke dalamnya.
   */
  list = async (req: Request, res: Response): Promise<void> => {
    const query = listEventsQuerySchema.parse(req.query);
    const result = await this.eventService.listEvents(query);

    sendSuccess(res, 200, 'Daftar event berhasil diambil', result.data, result.meta);
  };

  /**
   * `GET /events/export?format=csv|xlsx` (Phase 16 upgrade). Menerima
   * filter QUERY YANG SAMA seperti `list` di atas (search/category/
   * location/dateFrom/dateTo) — MINUS `page`/`limit`, karena export
   * secara definisi mengambil SEMUA baris yang cocok (dibatasi
   * `EXPORT_MAX_ROWS` di Service, bukan pagination per-halaman).
   */
  export = async (req: Request, res: Response): Promise<void> => {
    const { format, ...filters } = exportEventsQuerySchema.parse(req.query);
    const events = await this.eventService.exportEvents(filters);

    const columns: ExportColumn<EventResponseDto>[] = [
      { header: 'ID', value: (e) => e.id },
      { header: 'Judul', value: (e) => e.title },
      { header: 'Kategori', value: (e) => e.category },
      { header: 'Lokasi', value: (e) => e.location },
      { header: 'Tanggal', value: (e) => e.date.toISOString() },
      { header: 'Owner ID', value: (e) => e.ownerId },
      { header: 'Dibuat', value: (e) => e.createdAt.toISOString() },
    ];

    const timestamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const buffer = await toXlsxBuffer(events, columns, 'Events');
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="events-${timestamp}.xlsx"`);
      res.send(buffer);
      return;
    }

    const csv = toCsv(events, columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="events-${timestamp}.csv"`);
    res.send(csv);
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.getEventById(req.params.id);
    sendSuccess(res, 200, 'Detail event berhasil diambil', event);
  };

  /**
   * Otorisasi kepemilikan (pemilik ATAU admin) ditegakkan di
   * `EventService.updateEvent`, bukan di sini — Controller hanya
   * meneruskan identitas requester.
   */
  update = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const input = updateEventSchema.parse(req.body);
    const event = await this.eventService.updateEvent(req.params.id, input, req.user);

    await this.auditService.logUpdate('Event', event.id, {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, 200, 'Event berhasil diperbarui', event);
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.eventService.deleteEvent(req.params.id, req.user);

    await this.auditService.logDelete('Event', req.params.id, {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    sendSuccess(res, 200, 'Event berhasil dihapus', null);
  };
}
