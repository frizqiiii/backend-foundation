import type { Request, Response } from 'express';
import { EventController } from './event.controller';
import type { EventService } from './event.service';
import type { AuditService } from '../audit/audit.service';
import { UnauthorizedError } from '../../shared/utils/http-error';
import { toCsv, toXlsxBuffer } from '../../shared/utils/export';

jest.mock('../../shared/utils/export', () => ({
  toCsv: jest.fn().mockReturnValue('id,title\n1,Konser'),
  toXlsxBuffer: jest.fn().mockResolvedValue(Buffer.from('xlsx-bytes')),
}));

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
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

describe('EventController', () => {
  let eventService: jest.Mocked<EventService>;
  let auditService: jest.Mocked<AuditService>;
  let controller: EventController;

  const sampleEvent = {
    id: 'event-1',
    title: 'Konser musik',
    category: 'Musik',
    location: 'Jakarta',
    date: new Date('2026-12-01T00:00:00.000Z'),
    ownerId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    eventService = {
      createEvent: jest.fn(),
      listEvents: jest.fn(),
      exportEvents: jest.fn(),
      getEventById: jest.fn(),
      updateEvent: jest.fn(),
      deleteEvent: jest.fn(),
    } as unknown as jest.Mocked<EventService>;
    auditService = {
      logCreate: jest.fn(),
      logUpdate: jest.fn(),
      logDelete: jest.fn(),
    } as unknown as jest.Mocked<AuditService>;
    controller = new EventController(eventService, auditService);
  });

  describe('create', () => {
    it('membuat event atas nama req.user.id, mencatat audit CREATE, membalas 201', async () => {
      const req = createMockRequest({
        user: { id: 'user-1' },
        body: { title: 'Konser musik', category: 'Musik', location: 'Jakarta', date: '2026-12-01' },
      });
      const res = createMockResponse();
      eventService.createEvent.mockResolvedValue(sampleEvent as never);

      await controller.create(req, res);

      expect(eventService.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Konser musik' }),
        'user-1'
      );
      expect(auditService.logCreate).toHaveBeenCalledWith(
        'Event',
        'event-1',
        expect.objectContaining({ userId: 'user-1' })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow(UnauthorizedError);
      expect(eventService.createEvent).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('endpoint publik: TIDAK membutuhkan req.user, membalas data+meta', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const result = { data: [sampleEvent], meta: { page: 1, limit: 10, total: 1, totalPages: 1 } };
      eventService.listEvents.mockResolvedValue(result as never);

      await controller.list(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: result.data, meta: result.meta })
      );
    });
  });

  describe('export', () => {
    it('default format csv: memanggil toCsv, mengatur header Content-Type/Content-Disposition yang benar', async () => {
      const req = createMockRequest({ query: {} });
      const res = createMockResponse();
      eventService.exportEvents.mockResolvedValue([sampleEvent] as never);

      await controller.export(req, res);

      expect(eventService.exportEvents).toHaveBeenCalledWith(
        expect.not.objectContaining({ format: expect.anything() })
      );
      expect(toCsv).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('.csv')
      );
      expect(res.send).toHaveBeenCalledWith('id,title\n1,Konser');
    });

    it('P5 — kolom yang diteruskan ke toCsv memetakan field event dengan benar (termasuk format tanggal ISO)', async () => {
      const req = createMockRequest({ query: {} });
      const res = createMockResponse();
      eventService.exportEvents.mockResolvedValue([sampleEvent] as never);

      await controller.export(req, res);

      const [, columns] = (toCsv as jest.Mock).mock.calls[0];
      const row = Object.fromEntries(
        columns.map((col: { header: string; value: (e: typeof sampleEvent) => string }) => [
          col.header,
          col.value(sampleEvent),
        ])
      );

      expect(row).toEqual({
        ID: 'event-1',
        Judul: 'Konser musik',
        Kategori: 'Musik',
        Lokasi: 'Jakarta',
        Tanggal: '2026-12-01T00:00:00.000Z',
        'Owner ID': 'user-1',
        Dibuat: '2026-01-01T00:00:00.000Z',
      });
    });

    it('P5 — format xlsx: memanggil toXlsxBuffer, mengatur Content-Type spreadsheet yang benar', async () => {
      const req = createMockRequest({ query: { format: 'xlsx' } });
      const res = createMockResponse();
      eventService.exportEvents.mockResolvedValue([sampleEvent] as never);

      await controller.export(req, res);

      expect(toXlsxBuffer).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('.xlsx')
      );
      expect(res.send).toHaveBeenCalledWith(Buffer.from('xlsx-bytes'));
    });

    it('P5 — filter dateFrom>dateTo ditolak validasi SEBELUM sampai ke exportEvents (konsisten dengan bug-fix P5 di event.dto.ts)', async () => {
      const req = createMockRequest({
        query: { dateFrom: '2026-12-31', dateTo: '2026-01-01' },
      });
      const res = createMockResponse();

      await expect(controller.export(req, res)).rejects.toThrow();
      expect(eventService.exportEvents).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('endpoint publik: membalas detail event dari service', async () => {
      const req = createMockRequest({ params: { id: 'event-1' } });
      const res = createMockResponse();
      eventService.getEventById.mockResolvedValue(sampleEvent as never);

      await controller.getById(req, res);

      expect(eventService.getEventById).toHaveBeenCalledWith('event-1');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: sampleEvent }));
    });
  });

  describe('update', () => {
    it('meneruskan req.user penuh ke service (otorisasi kepemilikan di Service), mencatat audit UPDATE', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', role: 'ORGANIZER' },
        params: { id: 'event-1' },
        body: { title: 'Judul baru' },
      });
      const res = createMockResponse();
      eventService.updateEvent.mockResolvedValue(sampleEvent as never);

      await controller.update(req, res);

      expect(eventService.updateEvent).toHaveBeenCalledWith(
        'event-1',
        { title: 'Judul baru' },
        { id: 'user-1', role: 'ORGANIZER' }
      );
      expect(auditService.logUpdate).toHaveBeenCalled();
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ params: { id: 'event-1' }, body: {} });
      const res = createMockResponse();

      await expect(controller.update(req, res)).rejects.toThrow(UnauthorizedError);
      expect(eventService.updateEvent).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('menghapus event, meneruskan req.user penuh, mencatat audit DELETE', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', role: 'ADMIN' },
        params: { id: 'event-1' },
      });
      const res = createMockResponse();

      await controller.remove(req, res);

      expect(eventService.deleteEvent).toHaveBeenCalledWith('event-1', {
        id: 'user-1',
        role: 'ADMIN',
      });
      expect(auditService.logDelete).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ params: { id: 'event-1' } });
      const res = createMockResponse();

      await expect(controller.remove(req, res)).rejects.toThrow(UnauthorizedError);
      expect(eventService.deleteEvent).not.toHaveBeenCalled();
    });
  });
});
