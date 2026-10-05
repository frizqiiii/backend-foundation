import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/config/database';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import { EventRepository, type CreateEventData } from './event.repository';
import type { ListEventsQueryDto } from './event.dto';

/**
 * R16 — `EventRepository` di bawah FORCE RLS, dengan Prisma dan Postgres SUNGGUHAN.
 *
 * Latar belakang: setelah role aplikasi dipastikan NON-superuser (R12), RLS benar-benar berlaku. Repository events
 * saat itu memakai `this.prisma` biasa, yaitu koneksi yang TIDAK membawa `app.tenant_id`, sehingga di runtime:
 * `POST /events` gagal 500 (`42501 new row violates row-level security policy`) dan `GET /events` selalu kosong.
 * Unit test dengan Prisma ter-mock tidak bisa menangkap ini; hanya database sungguhan yang bisa.
 *
 * Test ini meniru `tenantMiddleware`: membuka transaksi, `set_config('app.tenant_id', ...)`, lalu menjalankan
 * repository di dalam `runWithTenantContext` dengan `db: tx`. Dijalankan lewat `npm run test:rls`
 * (DB `backend_foundation_rls_test`; lihat `jest.setup.rls-e2e.ts`). Role database HARUS non-superuser.
 *
 * Yang dibuktikan:
 *  1. KONTROL — `prisma.event.create` biasa (tanpa `app.tenant_id`) DITOLAK RLS. Ini mekanisme bug aslinya, dan
 *     memastikan test lain bermakna: kalau kontrol ini gagal, role kamu mem-bypass RLS dan test tidak membuktikan apa pun.
 *  2. `create` lewat repository berhasil dan tersimpan dengan tenantId yang benar.
 *  3. `findMany` / `findById` hanya melihat event milik tenant aktif.
 *  4. `update` / `delete` (soft) berhasil untuk tenant pemilik dan DITOLAK untuk tenant lain.
 */
describe('EventRepository di bawah FORCE RLS — database sungguhan (R16)', () => {
  const repository = new EventRepository(prisma);
  const marker = `rls-${randomUUID()}`;
  let tenantAId: string;
  let tenantBId: string;
  let ownerId: string;

  async function withBypass<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx);
    });
  }

  // Meniru `tenantMiddleware`: transaksi + `app.tenant_id`, context membawa `tx`.
  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return runWithTenantContext({ tenantId, tenantSlug: 'rls-test', db: tx }, fn);
    });
  }

  function eventData(label: string): CreateEventData {
    return {
      title: `${marker} ${label}`,
      category: 'Musik',
      location: 'Jakarta',
      date: new Date('2030-01-01'),
      ownerId,
    };
  }

  function listQuery(): ListEventsQueryDto {
    return { page: 1, limit: 10, search: marker } as ListEventsQueryDto;
  }

  async function rowOf(id: string) {
    return withBypass((tx) => tx.event.findUnique({ where: { id } }));
  }

  beforeAll(async () => {
    const tenantA = await prisma.tenant.create({
      data: { slug: `events-rls-a-${randomUUID()}`, name: 'Events RLS A' },
    });
    const tenantB = await prisma.tenant.create({
      data: { slug: `events-rls-b-${randomUUID()}`, name: 'Events RLS B' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    const owner = await prisma.user.create({
      data: {
        email: `events-rls-${randomUUID()}@example.com`,
        name: 'Events RLS Owner',
        password: null,
      },
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await withBypass((tx) =>
      tx.event.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } })
    );
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
  });

  it('KONTROL: prisma.event.create biasa (tanpa app.tenant_id) ditolak FORCE RLS', async () => {
    await expect(
      prisma.event.create({ data: { ...eventData('kontrol'), tenantId: tenantAId } })
    ).rejects.toThrow(/row-level security/i);
  });

  it('create lewat repository (tenant aktif) berhasil dan tersimpan dengan tenantId yang benar', async () => {
    const created = await asTenant(tenantAId, () => repository.create(eventData('dibuat-a')));

    expect(created.tenantId).toBe(tenantAId);
    expect((await rowOf(created.id))?.tenantId).toBe(tenantAId);
  });

  it('findMany dan findById hanya melihat event milik tenant aktif', async () => {
    const eventA = await asTenant(tenantAId, () => repository.create(eventData('milik-a')));
    const eventB = await asTenant(tenantBId, () => repository.create(eventData('milik-b')));

    const listA = await asTenant(tenantAId, () => repository.findMany(listQuery()));
    const listB = await asTenant(tenantBId, () => repository.findMany(listQuery()));

    expect(listA.data.map((e) => e.id)).toContain(eventA.id);
    expect(listA.data.map((e) => e.id)).not.toContain(eventB.id);
    expect(listA.total).toBe(listA.data.length);
    expect(listB.data.map((e) => e.id)).toEqual([eventB.id]);
    expect(listB.total).toBe(1);

    expect(await asTenant(tenantAId, () => repository.findById(eventA.id))).toMatchObject({
      id: eventA.id,
    });
    expect(await asTenant(tenantBId, () => repository.findById(eventA.id))).toBeNull();
  });

  it('update: berhasil untuk tenant pemilik, DITOLAK untuk tenant lain (baris tidak berubah)', async () => {
    const event = await asTenant(tenantAId, () => repository.create(eventData('untuk-update')));

    await expect(
      asTenant(tenantBId, () => repository.update(event.id, { title: `${marker} diretas` }))
    ).rejects.toThrow();
    expect((await rowOf(event.id))?.title).toBe(`${marker} untuk-update`);

    const updated = await asTenant(tenantAId, () =>
      repository.update(event.id, { title: `${marker} diubah` })
    );
    expect(updated.title).toBe(`${marker} diubah`);
  });

  it('delete (soft): DITOLAK untuk tenant lain, berhasil untuk pemilik dan hilang dari findById', async () => {
    const event = await asTenant(tenantAId, () => repository.create(eventData('untuk-delete')));

    await expect(asTenant(tenantBId, () => repository.delete(event.id))).rejects.toThrow();
    expect((await rowOf(event.id))?.deletedAt).toBeNull();

    await asTenant(tenantAId, () => repository.delete(event.id));

    expect((await rowOf(event.id))?.deletedAt).toBeInstanceOf(Date);
    expect(await asTenant(tenantAId, () => repository.findById(event.id))).toBeNull();
  });
});
