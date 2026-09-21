import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/config/database';
import { PrivacyRepository } from './privacy.repository';
import { UserRepository } from '../users/user.repository';

/**
 * Temuan T15 — erasure (item 2.3) di bawah FORCE RLS, dengan Prisma dan Postgres SUNGGUHAN.
 *
 * Sama seperti `rls-bypass.e2e.spec.ts`: TIDAK ada `jest.mock` untuk database. RLS ditegakkan database, jadi
 * hanya database sungguhan yang bisa membuktikan bahwa `PrivacyRepository.eraseUserData` benar-benar
 * menghapus API key, dan bahwa akun soft-deleted (target job retensi) bisa ditemukan untuk di-erasure.
 * Dijalankan lewat `npm run test:rls` (DB `backend_foundation_rls_test`; lihat `jest.setup.rls-e2e.ts`).
 *
 * Tiga hal dibuktikan:
 *  1. KONTROL — transaksi biasa (tanpa `app.tenant_id`/`app.bypass_rls`) menghapus 0 baris `api_keys` TANPA
 *     error. Ini mekanisme bug aslinya, dan sekaligus memastikan test 2 bermakna: kalau kontrol ini gagal, role
 *     database kamu mem-bypass RLS (superuser/BYPASSRLS) dan test ini tidak bisa membuktikan apa pun.
 *  2. `eraseUserData` menghapus API key user (lintas RLS) dan men-scrub baris user.
 *  3. `findByIdIncludingDeleted` menemukan akun soft-deleted, sedangkan `findById` tidak.
 */
describe('Erasure di bawah FORCE RLS — database sungguhan (temuan T15)', () => {
  const createdUserIds: string[] = [];
  let tenantId: string;
  let controlUserId: string;
  let erasedUserId: string;
  let softDeletedUserId: string;

  async function withBypass<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx);
    });
  }

  async function createUser(
    label: string,
    extra: Prisma.UserCreateInput | object = {}
  ): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `erasure-rls-${label}-${randomUUID()}@example.com`,
        name: `Erasure RLS ${label}`,
        password: null,
        ...extra,
      },
    });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function createApiKey(userId: string): Promise<string> {
    // Dibuat di bawah bypass supaya SETUP tidak bergantung pada policy yang sedang diuji.
    const key = await withBypass((tx) =>
      tx.apiKey.create({
        data: {
          userId,
          tenantId,
          name: 'kunci uji erasure',
          keyPrefix: 'bfk_test',
          keyHash: `hash-${randomUUID()}`,
        },
      })
    );
    return key.id;
  }

  async function apiKeysOf(userId: string): Promise<number> {
    return withBypass((tx) => tx.apiKey.count({ where: { userId } }));
  }

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { slug: `erasure-rls-${randomUUID()}`, name: 'Erasure RLS Tenant' },
    });
    tenantId = tenant.id;
    controlUserId = await createUser('kontrol');
    erasedUserId = await createUser('target');
    softDeletedUserId = await createUser('softdeleted', { deletedAt: new Date('2026-01-01') });
  });

  afterAll(async () => {
    await withBypass((tx) => tx.apiKey.deleteMany({ where: { userId: { in: createdUserIds } } }));
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  });

  it('KONTROL: transaksi biasa (tanpa bypass) menghapus 0 baris api_keys tanpa error — kunci tetap ada', async () => {
    await createApiKey(controlUserId);

    const result = await prisma.$transaction((tx) =>
      tx.apiKey.deleteMany({ where: { userId: controlUserId } })
    );

    expect(result.count).toBe(0);
    expect(await apiKeysOf(controlUserId)).toBe(1);
  });

  it('eraseUserData menghapus API key milik user (lintas RLS) dan men-scrub baris user', async () => {
    await createApiKey(erasedUserId);
    await createApiKey(erasedUserId);
    expect(await apiKeysOf(erasedUserId)).toBe(2);

    const erased = await new PrivacyRepository(prisma).eraseUserData(erasedUserId);

    expect(await apiKeysOf(erasedUserId)).toBe(0);
    expect(erased.email).toBe(`erased-${erasedUserId}@erased.invalid`);
    expect(erased.name).toBe('Deleted User');
    expect(erased.erasedAt).toBeInstanceOf(Date);
    // Kunci milik user LAIN tidak tersentuh.
    expect(await apiKeysOf(controlUserId)).toBe(1);
  });

  it('akun soft-deleted: findByIdIncludingDeleted menemukannya, findById (jalur auth) tidak', async () => {
    const repository = new UserRepository(prisma);

    expect(await repository.findById(softDeletedUserId)).toBeNull();
    expect(await repository.findByIdIncludingDeleted(softDeletedUserId)).toMatchObject({
      id: softDeletedUserId,
    });
  });
});
