import { EventService } from './event.service';
import type { EventRepository } from './event.repository';
import { ForbiddenError } from '../../shared/utils/http-error';

jest.mock('../../shared/queue/notification.queue', () => ({
  enqueueNotificationJob: jest.fn(),
}));

/**
 * R20 — EventService memicu webhook setelah operasi bisnis BERHASIL, dan hanya itu.
 */
describe('EventService memicu webhook (R20)', () => {
  const ownerId = 'owner-123';
  const dbEvent = {
    id: 'event-123',
    title: 'Konferensi TypeScript 2026',
    description: 'Konferensi tahunan seputar TypeScript',
    category: 'Teknologi',
    location: 'Jakarta',
    date: new Date('2026-09-01T09:00:00.000Z'),
    ownerId,
    tenantId: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  let repo: jest.Mocked<EventRepository>;
  let trigger: jest.Mock;
  let service: EventService;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<EventRepository>;
    trigger = jest.fn().mockResolvedValue(undefined);
    service = new EventService(repo, { trigger });
  });

  it('createEvent: memicu event.created dengan payload yang sama dengan response API', async () => {
    repo.create.mockResolvedValue(dbEvent);

    const result = await service.createEvent(
      {
        title: dbEvent.title,
        description: dbEvent.description,
        category: dbEvent.category,
        location: dbEvent.location,
        date: dbEvent.date,
      },
      ownerId
    );

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith('event.created', { ...result });
  });

  it('updateEvent: memicu event.updated dengan data hasil update', async () => {
    repo.findById.mockResolvedValue(dbEvent);
    repo.update.mockResolvedValue({ ...dbEvent, title: 'Judul Baru' });

    await service.updateEvent(dbEvent.id, { title: 'Judul Baru' }, { id: ownerId, role: 'USER' });

    expect(trigger).toHaveBeenCalledWith(
      'event.updated',
      expect.objectContaining({ id: dbEvent.id, title: 'Judul Baru' })
    );
  });

  it('updateEvent: ditolak (bukan pemilik) TIDAK memicu webhook', async () => {
    repo.findById.mockResolvedValue(dbEvent);

    await expect(
      service.updateEvent(dbEvent.id, { title: 'x' }, { id: 'stranger', role: 'USER' })
    ).rejects.toThrow(ForbiddenError);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('deleteEvent: memicu event.deleted hanya dengan id', async () => {
    repo.findById.mockResolvedValue(dbEvent);

    await service.deleteEvent(dbEvent.id, { id: ownerId, role: 'USER' });

    expect(trigger).toHaveBeenCalledWith('event.deleted', { id: dbEvent.id });
  });

  it('deleteEvent: ditolak (bukan pemilik) TIDAK memicu webhook', async () => {
    repo.findById.mockResolvedValue(dbEvent);

    await expect(service.deleteEvent(dbEvent.id, { id: 'stranger', role: 'USER' })).rejects.toThrow(
      ForbiddenError
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it('kegagalan webhook TIDAK menggagalkan operasi bisnis', async () => {
    repo.findById.mockResolvedValue(dbEvent);
    trigger.mockRejectedValue(new Error('webhook down'));

    await expect(
      service.deleteEvent(dbEvent.id, { id: ownerId, role: 'USER' })
    ).resolves.toBeUndefined();
  });
});
