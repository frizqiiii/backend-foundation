import { EventService } from './event.service';
import type { RequesterContext } from './event.service';
import type { EventRepository } from './event.repository';
import { NotFoundError, ForbiddenError } from '../../shared/utils/http-error';
import { enqueueNotificationJob } from '../../shared/queue/notification.queue';

jest.mock('../../shared/queue/notification.queue', () => ({
  enqueueNotificationJob: jest.fn(),
}));

const mockedEnqueueNotificationJob = enqueueNotificationJob as jest.Mock;

describe('EventService', () => {
  let eventService: EventService;
  let eventRepository: jest.Mocked<EventRepository>;

  const ownerId = 'owner-123';
  const dbEvent = {
    id: 'event-123',
    title: 'Konferensi TypeScript 2026',
    description: 'Konferensi tahunan seputar TypeScript',
    category: 'Teknologi',
    location: 'Jakarta',
    date: new Date('2026-09-01T09:00:00.000Z'),
    ownerId,
    // Phase 11 (tenant isolation) menambahkan dua kolom ini ke model
    // Event — fixture ini dibuat SEBELUM Phase 11, jadi belum pernah
    // ikut diupdate. `null` dipakai (bukan string tenant sungguhan)
    // karena EventService di-test di sini TIDAK melibatkan tenant
    // context sama sekali (itu diuji terpisah di level HTTP —
    // `app.integration.spec.ts`, describe block "Event flow (Isolasi
    // Tenant)"); di sini cukup mencerminkan bentuk data yang valid.
    tenantId: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    eventRepository = {
      create: jest.fn(),
      findMany: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<EventRepository>;

    eventService = new EventService(eventRepository);
  });

  describe('createEvent', () => {
    it('membuat event dengan ownerId dari requester, bukan dari input', async () => {
      const input = {
        title: dbEvent.title,
        description: dbEvent.description,
        category: dbEvent.category,
        location: dbEvent.location,
        date: dbEvent.date,
      };
      eventRepository.create.mockResolvedValue(dbEvent);

      const result = await eventService.createEvent(input, ownerId);

      expect(eventRepository.create).toHaveBeenCalledWith({ ...input, ownerId });
      expect(result.ownerId).toBe(ownerId);
    });
  });

  describe('listEvents', () => {
    it('meneruskan query filter/pagination ke repository dan membentuk metadata paginasi yang benar', async () => {
      const query = { page: 2, limit: 5, category: 'Teknologi' } as Parameters<
        EventService['listEvents']
      >[0];
      eventRepository.findMany.mockResolvedValue({ data: [dbEvent], total: 12 });

      const result = await eventService.listEvents(query);

      expect(eventRepository.findMany).toHaveBeenCalledWith(query);
      expect(result.meta).toEqual({ page: 2, limit: 5, total: 12, totalPages: 3 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe('getEventById', () => {
    it('mengembalikan event ketika ditemukan', async () => {
      eventRepository.findById.mockResolvedValue(dbEvent);

      const result = await eventService.getEventById(dbEvent.id);

      expect(result.id).toBe(dbEvent.id);
    });

    it('melempar NotFoundError ketika event tidak ditemukan', async () => {
      eventRepository.findById.mockResolvedValue(null);

      await expect(eventService.getEventById('unknown-id')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateEvent', () => {
    const updateInput = { title: 'Judul Baru' };

    it('berhasil ketika requester adalah pemilik event', async () => {
      eventRepository.findById.mockResolvedValue(dbEvent);
      eventRepository.update.mockResolvedValue({ ...dbEvent, ...updateInput });

      const result = await eventService.updateEvent(dbEvent.id, updateInput, {
        id: ownerId,
        role: 'USER',
      } satisfies RequesterContext);

      expect(eventRepository.update).toHaveBeenCalledWith(dbEvent.id, updateInput);
      expect(result.title).toBe('Judul Baru');
      // Pemilik mengubah miliknya sendiri — tidak perlu notifikasi.
      expect(mockedEnqueueNotificationJob).not.toHaveBeenCalled();
    });

    it('berhasil ketika requester adalah ADMIN meski bukan pemilik (kapabilitas moderasi), DAN mengirim notifikasi ke pemilik asli', async () => {
      eventRepository.findById.mockResolvedValue(dbEvent);
      eventRepository.update.mockResolvedValue({ ...dbEvent, ...updateInput });

      const result = await eventService.updateEvent(dbEvent.id, updateInput, {
        id: 'admin-999',
        role: 'ADMIN',
      } satisfies RequesterContext);

      expect(result.title).toBe('Judul Baru');
      expect(mockedEnqueueNotificationJob).toHaveBeenCalledWith({
        userId: ownerId,
        message: expect.stringContaining(dbEvent.title),
      });
    });

    it('melempar ForbiddenError ketika requester BUKAN pemilik dan BUKAN admin', async () => {
      eventRepository.findById.mockResolvedValue(dbEvent);

      await expect(
        eventService.updateEvent(dbEvent.id, updateInput, {
          id: 'another-user-id',
          role: 'ORGANIZER',
        } satisfies RequesterContext)
      ).rejects.toThrow(ForbiddenError);

      expect(eventRepository.update).not.toHaveBeenCalled();
    });

    it('melempar NotFoundError ketika event tidak ditemukan (sebelum pengecekan otorisasi)', async () => {
      eventRepository.findById.mockResolvedValue(null);

      await expect(
        eventService.updateEvent('unknown-id', updateInput, {
          id: ownerId,
          role: 'USER',
        } satisfies RequesterContext)
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('deleteEvent', () => {
    it('berhasil menghapus event ketika requester adalah pemilik (tanpa notifikasi)', async () => {
      eventRepository.findById.mockResolvedValue(dbEvent);

      await eventService.deleteEvent(dbEvent.id, {
        id: ownerId,
        role: 'USER',
      } satisfies RequesterContext);

      expect(eventRepository.delete).toHaveBeenCalledWith(dbEvent.id);
      expect(mockedEnqueueNotificationJob).not.toHaveBeenCalled();
    });

    it('mengirim notifikasi ke pemilik asli ketika ADMIN yang menghapus (bukan pemiliknya)', async () => {
      eventRepository.findById.mockResolvedValue(dbEvent);

      await eventService.deleteEvent(dbEvent.id, {
        id: 'admin-999',
        role: 'ADMIN',
      } satisfies RequesterContext);

      expect(mockedEnqueueNotificationJob).toHaveBeenCalledWith({
        userId: ownerId,
        message: expect.stringContaining(dbEvent.title),
      });
    });

    it('melempar ForbiddenError ketika requester bukan pemilik maupun admin', async () => {
      eventRepository.findById.mockResolvedValue(dbEvent);

      await expect(
        eventService.deleteEvent(dbEvent.id, {
          id: 'another-user-id',
          role: 'USER',
        } satisfies RequesterContext)
      ).rejects.toThrow(ForbiddenError);

      expect(eventRepository.delete).not.toHaveBeenCalled();
    });

    it('P5 — melempar NotFoundError kalau event tidak ditemukan', async () => {
      eventRepository.findById.mockResolvedValue(null);

      await expect(
        eventService.deleteEvent('tidak-ada', {
          id: ownerId,
          role: 'USER',
        } satisfies RequesterContext)
      ).rejects.toThrow(NotFoundError);

      expect(eventRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('exportEvents', () => {
    it('P5 — mengambil SEMUA baris cocok (page:1, limit:EXPORT_MAX_ROWS) dan memetakannya ke response DTO', async () => {
      eventRepository.findMany.mockResolvedValue({ data: [dbEvent], total: 1 });

      const result = await eventService.exportEvents({ category: 'Musik' });

      expect(eventRepository.findMany).toHaveBeenCalledWith({
        category: 'Musik',
        page: 1,
        limit: 5000,
      });
      expect(result).toEqual([expect.objectContaining({ id: dbEvent.id })]);
    });
  });
});
