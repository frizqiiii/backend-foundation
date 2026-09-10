import type { RoleName } from '../../shared/types/role';
import type { EventRepository } from './event.repository';
import type {
  CreateEventDto,
  UpdateEventDto,
  ListEventsQueryDto,
  EventResponseDto,
} from './event.dto';
import { NotFoundError, ForbiddenError } from '../../shared/utils/http-error';
import { hasPermission } from '../../shared/security/permissions';
import { buildPaginatedResult, type PaginatedResult } from '../../shared/pagination';
import { getOrSetCache, invalidateByPattern } from '../../shared/utils/cache';
import { cacheKeys } from '../../shared/utils/cache-keys';
import { enqueueNotificationJob } from '../../shared/queue/notification.queue';

const EVENTS_LIST_CACHE_TTL_SECONDS = 60;

export interface RequesterContext {
  id: string;
  role: RoleName;
}

/**
 * Service Layer modul `events`.
 *
 * Siapa boleh MEMBUAT event dibatasi di level routing (`requireRole`),
 * bukan di sini — itu murni soal role, tidak butuh data resource apa
 * pun. Siapa boleh MENGUBAH/MENGHAPUS event tertentu TIDAK bisa
 * ditentukan oleh role saja (perlu tahu siapa pemilik event-nya),
 * jadi pengecekan itu dilakukan di sini (`assertCanModify`).
 */
export class EventService {
  constructor(private readonly eventRepository: EventRepository) {}

  async createEvent(input: CreateEventDto, ownerId: string): Promise<EventResponseDto> {
    const event = await this.eventRepository.create({ ...input, ownerId });
    await invalidateByPattern(cacheKeys.eventsListPattern());
    return this.toResponseDto(event);
  }

  /**
   * Di-cache 60 detik PER KOMBINASI query (pagination+filter+search
   * berbeda = key berbeda) — sebuah write (create/update/delete)
   * tidak bisa tahu kombinasi query mana saja yang bakal terpengaruh,
   * jadi invalidasinya memakai `invalidateByPattern` (hapus SEMUA
   * variasi sekaligus), bukan menghapus satu key spesifik.
   */
  async listEvents(query: ListEventsQueryDto): Promise<PaginatedResult<EventResponseDto>> {
    const queryKey = JSON.stringify(query, Object.keys(query).sort());
    return getOrSetCache(
      cacheKeys.eventsList(queryKey),
      EVENTS_LIST_CACHE_TTL_SECONDS,
      async () => {
        const { data, total } = await this.eventRepository.findMany(query);
        return buildPaginatedResult(
          data.map((event) => this.toResponseDto(event)),
          total,
          query.page,
          query.limit
        );
      }
    );
  }

  /**
   * Export CSV/Excel (Phase 16 upgrade) — SENGAJA memanggil
   * `eventRepository.findMany` LANGSUNG dengan `limit` di atas batas
   * 100 yang dipaksakan `listEventsQuerySchema` untuk listing biasa
   * (lihat `event.dto.ts`), bukan lewat `listEvents()` di atas.
   * Alasannya: batas 100 itu untuk MELINDUNGI response JSON pagination
   * normal dari payload raksasa yang tidak perlu (client web biasanya
   * hanya butuh satu halaman); export justru KEBALIKANNYA — tujuannya
   * memang mengambil banyak baris sekaligus dalam satu file.
   *
   * TIDAK memakai cache (`getOrSetCache`) seperti `listEvents` —
   * export adalah operasi SEKALI PAKAI per klik, bukan dibaca
   * berulang-ulang oleh banyak user dalam kombinasi filter yang sama
   * seperti listing biasa; menyimpannya di cache hanya membebani
   * Redis dengan payload besar yang kemungkinan besar tidak akan
   * pernah dibaca ulang.
   *
   * `EXPORT_MAX_ROWS` — pengaman keras supaya satu request export
   * tidak bisa diminta menarik JUTAAN baris sekaligus (yang akan
   * membebani memori proses Node & waktu respons) — kalau data lebih
   * banyak dari ini, operator perlu mempersempit filter (rentang
   * tanggal/kategori), bukan menaikkan batas ini tanpa batas.
   */
  async exportEvents(
    query: Omit<ListEventsQueryDto, 'page' | 'limit'>
  ): Promise<EventResponseDto[]> {
    const EXPORT_MAX_ROWS = 5000;
    const { data } = await this.eventRepository.findMany({
      ...query,
      page: 1,
      limit: EXPORT_MAX_ROWS,
    });
    return data.map((event) => this.toResponseDto(event));
  }

  async getEventById(id: string): Promise<EventResponseDto> {
    const event = await this.eventRepository.findById(id);
    if (!event) {
      throw new NotFoundError('Event tidak ditemukan');
    }
    return this.toResponseDto(event);
  }

  async updateEvent(
    id: string,
    input: UpdateEventDto,
    requester: RequesterContext
  ): Promise<EventResponseDto> {
    const existing = await this.eventRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Event tidak ditemukan');
    }

    this.assertCanModify(existing.ownerId, requester);

    const updated = await this.eventRepository.update(id, input);
    await invalidateByPattern(cacheKeys.eventsListPattern());
    await this.notifyIfModeratedByAdmin(
      existing.ownerId,
      requester,
      `Event "${existing.title}" Anda telah diubah oleh admin`
    );
    return this.toResponseDto(updated);
  }

  async deleteEvent(id: string, requester: RequesterContext): Promise<void> {
    const existing = await this.eventRepository.findById(id);
    if (!existing) {
      throw new NotFoundError('Event tidak ditemukan');
    }

    this.assertCanModify(existing.ownerId, requester);

    await this.eventRepository.delete(id);
    await invalidateByPattern(cacheKeys.eventsListPattern());
    await this.notifyIfModeratedByAdmin(
      existing.ownerId,
      requester,
      `Event "${existing.title}" Anda telah dihapus oleh admin`
    );
  }

  /**
   * Kirim notifikasi (lewat `notification.queue.ts`) ke pemilik asli
   * resource HANYA ketika yang melakukan perubahan adalah ADMIN yang
   * BUKAN pemiliknya — pemilik yang mengubah resource miliknya
   * sendiri tidak perlu diberitahu tentang aksinya sendiri.
   */
  private async notifyIfModeratedByAdmin(
    ownerId: string,
    requester: RequesterContext,
    message: string
  ): Promise<void> {
    const isAdminActingOnBehalf =
      hasPermission(requester.role, 'event.moderate') && requester.id !== ownerId;
    if (isAdminActingOnBehalf) {
      await enqueueNotificationJob({ userId: ownerId, message });
    }
  }

  /**
   * Aturan otorisasi resource-level: pemilik event boleh mengubah
   * event miliknya sendiri; ADMIN boleh mengubah event siapa pun
   * (kapabilitas moderasi). Selain itu, ditolak dengan 403 — beda
   * dari 401 (`UnauthorizedError`): requester SUDAH diketahui
   * identitasnya (lolos `authMiddleware`), hanya saja tidak berhak
   * atas resource spesifik ini.
   */
  private assertCanModify(eventOwnerId: string, requester: RequesterContext): void {
    const isOwner = eventOwnerId === requester.id;
    const canModerate = hasPermission(requester.role, 'event.moderate');

    if (!isOwner && !canModerate) {
      throw new ForbiddenError('Anda hanya bisa mengubah atau menghapus event milik Anda sendiri');
    }
  }

  private toResponseDto(event: {
    id: string;
    title: string;
    description: string | null;
    category: string;
    location: string;
    date: Date;
    ownerId: string;
    createdAt: Date;
    updatedAt: Date;
  }): EventResponseDto {
    return {
      id: event.id,
      title: event.title,
      description: event.description,
      category: event.category,
      location: event.location,
      date: event.date,
      ownerId: event.ownerId,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };
  }
}
