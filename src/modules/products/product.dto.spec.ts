import {
  createProductSchema,
  upgradeProductSchema,
  listProductsQuerySchema,
  PRODUCT_CATEGORY_RANK,
} from './product.dto';

describe('createProductSchema', () => {
  it('menerima input valid dan menerapkan default stock: 1 kalau tidak diisi', () => {
    const result = createProductSchema.parse({
      title: 'Meja kayu',
      description: 'Meja kayu jati asli, kondisi baru',
      price: 500000,
    });

    expect(result).toEqual({
      title: 'Meja kayu',
      description: 'Meja kayu jati asli, kondisi baru',
      price: 500000,
      stock: 1,
    });
  });

  it('menolak title kurang dari 3 karakter', () => {
    const result = createProductSchema.safeParse({
      title: 'ab',
      description: 'Deskripsi yang cukup panjang',
      price: 1000,
    });

    expect(result.success).toBe(false);
  });

  it('menolak description kurang dari 10 karakter', () => {
    const result = createProductSchema.safeParse({
      title: 'Produk oke',
      description: 'pendek',
      price: 1000,
    });

    expect(result.success).toBe(false);
  });

  it('menolak price negatif', () => {
    const result = createProductSchema.safeParse({
      title: 'Produk oke',
      description: 'Deskripsi yang cukup panjang',
      price: -100,
    });

    expect(result.success).toBe(false);
  });

  it('menolak price non-integer (desimal)', () => {
    const result = createProductSchema.safeParse({
      title: 'Produk oke',
      description: 'Deskripsi yang cukup panjang',
      price: 99.99,
    });

    expect(result.success).toBe(false);
  });

  it('menolak stock negatif', () => {
    const result = createProductSchema.safeParse({
      title: 'Produk oke',
      description: 'Deskripsi yang cukup panjang',
      price: 1000,
      stock: -1,
    });

    expect(result.success).toBe(false);
  });

  it('TIDAK menerima category/status sebagai input (produk baru selalu STANDARD/ACTIVE) — field asing diabaikan, bukan ditolak, karena Zod default strip bukan passthrough', () => {
    const result = createProductSchema.parse({
      title: 'Produk oke',
      description: 'Deskripsi yang cukup panjang',
      price: 1000,
      category: 'PREMIUM',
      status: 'SOLD',
    });

    expect(result).not.toHaveProperty('category');
    expect(result).not.toHaveProperty('status');
  });
});

describe('upgradeProductSchema', () => {
  it.each(['FEATURED', 'PREMIUM'])('menerima toCategory: %s', (toCategory) => {
    const result = upgradeProductSchema.safeParse({ toCategory });
    expect(result.success).toBe(true);
  });

  it('menolak STANDARD sebagai tujuan upgrade (bukan tingkat yang valid untuk dituju)', () => {
    const result = upgradeProductSchema.safeParse({ toCategory: 'STANDARD' });
    expect(result.success).toBe(false);
  });

  it('menolak nilai yang bukan kategori sama sekali', () => {
    const result = upgradeProductSchema.safeParse({ toCategory: 'GOLD' });
    expect(result.success).toBe(false);
  });
});

describe('listProductsQuerySchema', () => {
  it('menerapkan default page:1 limit:20 kalau query kosong', () => {
    const result = listProductsQuerySchema.parse({});
    expect(result).toEqual({ page: 1, limit: 20 });
  });

  it('meng-coerce page/limit dari string (query string HTTP selalu string)', () => {
    const result = listProductsQuerySchema.parse({ page: '3', limit: '50' });
    expect(result).toEqual({ page: 3, limit: 50 });
  });

  it('menolak limit di atas 100', () => {
    const result = listProductsQuerySchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
  });

  it('menolak page kurang dari 1', () => {
    const result = listProductsQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });

  it('menerima status dan category yang valid sebagai filter opsional', () => {
    const result = listProductsQuerySchema.parse({ status: 'ACTIVE', category: 'FEATURED' });
    expect(result).toMatchObject({ status: 'ACTIVE', category: 'FEATURED' });
  });

  it('menolak status yang bukan enum yang valid', () => {
    const result = listProductsQuerySchema.safeParse({ status: 'DELETED' });
    expect(result.success).toBe(false);
  });
});

describe('PRODUCT_CATEGORY_RANK', () => {
  it('P5 — urutan tingkat kategori STANDARD < FEATURED < PREMIUM (dipakai ProductService.upgradeProduct untuk mencegah downgrade/lompat ke tingkat yang sama)', () => {
    expect(PRODUCT_CATEGORY_RANK.STANDARD).toBeLessThan(PRODUCT_CATEGORY_RANK.FEATURED);
    expect(PRODUCT_CATEGORY_RANK.FEATURED).toBeLessThan(PRODUCT_CATEGORY_RANK.PREMIUM);
  });
});
