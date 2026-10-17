import { ProductService } from './product.service';
import type { ProductRepository } from './product.repository';
import { getOrSetCache } from '../../shared/utils/cache';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';

jest.mock('../../shared/utils/cache', () => ({
  getOrSetCache: jest.fn(),
  invalidateByPattern: jest.fn(),
}));

const mockedGetOrSetCache = getOrSetCache as jest.Mock;

/**
 * R15 — cache list produk harus terisolasi per tenant (pola sama dengan S2 untuk events). Sebelumnya kunci hanya
 * `queryKey`: begitu list produk benar-benar terbaca (R15), hasil tenant A akan disajikan ke tenant B selama TTL.
 * `getOrSetCache` ditiru sebagai cache sungguhan berbasis Map supaya yang diuji adalah PERILAKU (siapa menerima
 * data siapa), bukan hanya string kunci.
 */
describe('ProductService.listProducts — isolasi cache per tenant (R15)', () => {
  const query = { page: 1, limit: 10 } as Parameters<ProductService['listProducts']>[0];
  let store: Map<string, unknown>;
  let repository: jest.Mocked<ProductRepository>;
  let service: ProductService;

  const row = (id: string) => ({
    id,
    title: `produk ${id}`,
    description: 'd',
    price: 1000,
    category: 'REGULAR',
    status: 'ACTIVE',
    stock: 5,
    userId: 'owner',
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
    repository = { findMany: jest.fn() } as unknown as jest.Mocked<ProductRepository>;
    service = new ProductService(repository);
  });

  it('tenant B TIDAK menerima hasil cache tenant A untuk query yang sama', async () => {
    repository.findMany
      .mockResolvedValueOnce({ data: [row('milik-a')] as never, total: 1 })
      .mockResolvedValueOnce({ data: [], total: 0 });

    const forA = await asTenant('tenant-a', () => service.listProducts(query));
    const forB = await asTenant('tenant-b', () => service.listProducts(query));

    expect(forA.data.map((p) => p.id)).toEqual(['milik-a']);
    expect(forB.data).toEqual([]);
    expect(repository.findMany).toHaveBeenCalledTimes(2);
  });

  it('tenant yang sama dengan query yang sama tetap memakai cache (tidak query ulang)', async () => {
    repository.findMany.mockResolvedValue({ data: [row('x')] as never, total: 1 });

    await asTenant('tenant-a', () => service.listProducts(query));
    await asTenant('tenant-a', () => service.listProducts(query));

    expect(repository.findMany).toHaveBeenCalledTimes(1);
  });

  it('TANPA konteks tenant: cache dilewati sama sekali (tidak membaca maupun menulis)', async () => {
    store.set('cache:products:list:salah', 'tidak-boleh-terbaca');
    repository.findMany.mockResolvedValue({ data: [], total: 0 });

    const result = await asTenant(null, () => service.listProducts(query));

    expect(mockedGetOrSetCache).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
    expect(repository.findMany).toHaveBeenCalledTimes(1);
  });

  it('hasil request tanpa tenant tidak mencemari cache tenant', async () => {
    repository.findMany
      .mockResolvedValueOnce({ data: [], total: 0 })
      .mockResolvedValueOnce({ data: [row('milik-a')] as never, total: 1 });

    await asTenant(null, () => service.listProducts(query));
    const forA = await asTenant('tenant-a', () => service.listProducts(query));

    expect(forA.data.map((p) => p.id)).toEqual(['milik-a']);
  });
});
