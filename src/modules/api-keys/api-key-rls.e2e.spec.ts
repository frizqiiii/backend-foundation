import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/config/database';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import { ApiKeyRepository } from './api-key.repository';

/**
 * R17 — `ApiKeyRepository` di bawah FORCE RLS, dengan Prisma dan Postgres SUNGGUHAN.
 *
 * Latar belakang: setelah role aplikasi dipastikan NON-superuser (R12), RLS benar-benar berlaku. Repository ini memakai
 * `this.prisma` biasa (koneksi tanpa `app.tenant_id`), sehingga di runtime `POST /api-keys` gagal 500
 * (`42501 new row violates row-level security policy for table "api_keys"`). Selain itu autentikasi API key mencari
 * key lewat hash SEBELUM tenant diketahui — tanpa bypass, lookup itu tidak akan pernah menemukan apa pun.
 *
 * Dijalankan lewat `npm run test:rls` (DB `backend_foundation_rls_test`; lihat `jest.setup.rls-e2e.ts`).
 * Role database HARUS non-superuser.
 *
 * Yang dibuktikan:
 *  1. KONTROL — akses biasa (tanpa `app.tenant_id`/`app.bypass_rls`) ke `api_keys`: create DITOLAK, findUnique
 *     tidak menemukan baris. Memastikan test lain bermakna (kalau gagal, role kamu mem-bypass RLS).
 *  2. `findByHash` dan `touchLastUsed` bekerja TANPA tenant context (jalur autentikasi API key).
 *  3. `create` / `findManyForUser` / `findByIdForUser` hanya melihat key milik tenant aktif.
 *  4. `revoke` / `updateRateLimitOverride` berhasil untuk tenant pemilik dan DITOLAK untuk tenant lain.
 */
describe('ApiKeyRepository di bawah FORCE RLS — database sungguhan (R17)', () => {
  const repository = new ApiKeyRepository(prisma);
  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  let userBId: string;

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

  function keyData(userId: string, tenantId: string) {
    return {
      userId,
      tenantId,
      name: 'rls test key',
      keyPrefix: 'bfk_test',
      keyHash: `hash-${randomUUID()}`,
      scopes: ['event.read'],
      expiresAt: null,
    };
  }

  // Setup dibuat di bawah bypass supaya TIDAK bergantung pada policy yang sedang diuji.
  async function seedKey(userId: string, tenantId: string) {
    return withBypass((tx) => tx.apiKey.create({ data: keyData(userId, tenantId) }));
  }

  async function rowOf(id: string) {
    return withBypass((tx) => tx.apiKey.findUnique({ where: { id } }));
  }

  beforeAll(async () => {
    const tenantA = await prisma.tenant.create({
      data: { slug: `apikey-rls-a-${randomUUID()}`, name: 'ApiKey RLS A' },
    });
    const tenantB = await prisma.tenant.create({
      data: { slug: `apikey-rls-b-${randomUUID()}`, name: 'ApiKey RLS B' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    const userA = await prisma.user.create({
      data: {
        email: `apikey-rls-a-${randomUUID()}@example.com`,
        name: 'ApiKey RLS A',
        password: null,
      },
    });
    const userB = await prisma.user.create({
      data: {
        email: `apikey-rls-b-${randomUUID()}@example.com`,
        name: 'ApiKey RLS B',
        password: null,
      },
    });
    userAId = userA.id;
    userBId = userB.id;
  });

  afterAll(async () => {
    await withBypass((tx) =>
      tx.apiKey.deleteMany({ where: { userId: { in: [userAId, userBId] } } })
    );
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
  });

  it('KONTROL: create biasa DITOLAK RLS dan findUnique biasa tidak menemukan key yang ada', async () => {
    const existing = await seedKey(userAId, tenantAId);

    await expect(prisma.apiKey.create({ data: keyData(userAId, tenantAId) })).rejects.toThrow(
      /row-level security/i
    );
    expect(await prisma.apiKey.findUnique({ where: { keyHash: existing.keyHash } })).toBeNull();
  });

  it('findByHash menemukan key TANPA tenant context (jalur autentikasi API key)', async () => {
    const existing = await seedKey(userAId, tenantAId);

    const found = await repository.findByHash(existing.keyHash);

    expect(found).toMatchObject({ id: existing.id, tenantId: tenantAId });
    expect(await repository.findByHash(`hash-tidak-ada-${randomUUID()}`)).toBeNull();
  });

  it('touchLastUsed mengisi lastUsedAt TANPA tenant context', async () => {
    const existing = await seedKey(userAId, tenantAId);
    expect(existing.lastUsedAt).toBeNull();

    await repository.touchLastUsed(existing.id);

    expect((await rowOf(existing.id))?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('create lewat repository (tenant aktif) berhasil; list dan findByIdForUser hanya melihat key tenant aktif', async () => {
    const created = await asTenant(tenantAId, () => repository.create(keyData(userAId, tenantAId)));
    const otherTenant = await asTenant(tenantBId, () =>
      repository.create(keyData(userBId, tenantBId))
    );

    expect(created.tenantId).toBe(tenantAId);

    const listA = await asTenant(tenantAId, () => repository.findManyForUser(userAId));
    expect(listA.map((k) => k.id)).toContain(created.id);
    expect(listA.map((k) => k.id)).not.toContain(otherTenant.id);

    expect(
      await asTenant(tenantAId, () => repository.findByIdForUser(created.id, userAId))
    ).toMatchObject({ id: created.id });
    expect(
      await asTenant(tenantBId, () => repository.findByIdForUser(created.id, userAId))
    ).toBeNull();
  });

  it('revoke: DITOLAK untuk tenant lain (key tetap aktif), berhasil untuk tenant pemilik', async () => {
    const key = await seedKey(userAId, tenantAId);

    await expect(asTenant(tenantBId, () => repository.revoke(key.id))).rejects.toThrow();
    expect((await rowOf(key.id))?.revokedAt).toBeNull();

    await asTenant(tenantAId, () => repository.revoke(key.id));

    expect((await rowOf(key.id))?.revokedAt).toBeInstanceOf(Date);
  });

  it('updateRateLimitOverride: DITOLAK untuk tenant lain, berhasil untuk tenant pemilik', async () => {
    const key = await seedKey(userAId, tenantAId);

    await expect(
      asTenant(tenantBId, () => repository.updateRateLimitOverride(key.id, 999))
    ).rejects.toThrow();
    expect((await rowOf(key.id))?.rateLimitOverridePerMinute).toBeNull();

    const updated = await asTenant(tenantAId, () =>
      repository.updateRateLimitOverride(key.id, 500)
    );
    expect(updated.rateLimitOverridePerMinute).toBe(500);
  });
});
