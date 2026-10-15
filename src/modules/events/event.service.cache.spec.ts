import { EventService } from './event.service';
import type { EventRepository } from './event.repository';
import { getOrSetCache } from '../../shared/utils/cache';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';

jest.mock('../../shared/queue/notification.queue', () => ({ enqueueNotificationJob: jest.fn() }));
jest.mock('../../shared/utils/cache', () => ({
  getOrSetCache: jest.fn(),
  invalidateByPattern: jest.fn(),
}));

const mockedGetOrSetCache = getOrSetCache as jest.Mock;

/**
 * S2 — cache list events harus terisolasi per tenant. Sebelumnya kunci hanya `queryKey`, jadi hasil list tenant A
 * disajikan ke tenant B (dan ke request tanpa tenant) selama TTL. Di sini `getOrSetCache` ditiru sebagai cache
 * sungguhan berbasis Map supaya yang diuji adalah PERILAKU (siapa menerima data siapa), bukan hanya string kunci.
 */
describe('EventService.listEvents — isolasi cache per tenant (S2)', () => {
  const query = { page: 1, limit: 10 } as Parameters<EventService['listEvents']>[0];
  let store: Map<string, unknown>;
  let repository: jest.Mocked<EventRepository>;
  let service: EventService;

  const row = (id: string, tenantId: string) => ({
    id,
    title: `event ${id}`,
    description: null,
    category: 'Musik',
    location: 'Jakarta',
    date: new Date('2030-01-01T00:00:00.000Z'),
    ownerId: 'owner',
    tenantId,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  const asTenant = <T>(tenantId: string | null, fn: () => T): T =>
    runWithTenantContext({ tenantId, tenantSlug: tenantId, db: null }, fn);

  beforeEach(() => {
    store = new Map();
    mockedGetOrSetCache.mockImplementation(
      async (key: string, _ttl: number, fetcher: () => Promise<unknown>) => {
        if (store.has(key)) return store.get(key);
        const value = await fetcher();
        store.set(key, value);
        return value;
      }
    );
    repository = {
      findMany: jest.fn(),
    } as unknown as jest.Mocked<EventRepository>;
    service = new EventService(repository);
  });

  it('tenant B TIDAK menerima hasil cache tenant A untuk query yang sama', async () => {
    repository.findMany
      .mockResolvedValueOnce({ data: [row('milik-a', 'tenant-a')], total: 1 })
      .mockResolvedValueOnce({ data: [], total: 0 });

    const forA = await asTenant('tenant-a', () => service.listEvents(query));
    const forB = await asTenant('tenant-b', () => service.listEvents(query));

    expect(forA.data.map((e) => e.id)).toEqual(['milik-a']);
    expect(forB.data).toEqual([]);
    expect(repository.findMany).toHaveBeenCalledTimes(2);
  });

  it('tenant yang sama dengan query yang sama tetap memakai cache (tidak query ulang)', async () => {
    repository.findMany.mockResolvedValue({ data: [row('x', 'tenant-a')], total: 1 });

    await asTenant('tenant-a', () => service.listEvents(query));
    await asTenant('tenant-a', () => service.listEvents(query));

    expect(repository.findMany).toHaveBeenCalledTimes(1);
  });

  it('TANPA konteks tenant: cache dilewati sama sekali (tidak membaca maupun menulis)', async () => {
    store.set('cache:events:list:salah', 'tidak-boleh-terbaca');
    repository.findMany.mockResolvedValue({ data: [], total: 0 });

    const result = await asTenant(null, () => service.listEvents(query));

    expect(mockedGetOrSetCache).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
    expect(repository.findMany).toHaveBeenCalledTimes(1);
  });

  it('hasil request tanpa tenant tidak mencemari cache tenant', async () => {
    repository.findMany
      .mockResolvedValueOnce({ data: [], total: 0 })
      .mockResolvedValueOnce({ data: [row('milik-a', 'tenant-a')], total: 1 });

    await asTenant(null, () => service.listEvents(query));
    const forA = await asTenant('tenant-a', () => service.listEvents(query));

    expect(forA.data.map((e) => e.id)).toEqual(['milik-a']);
  });
});
