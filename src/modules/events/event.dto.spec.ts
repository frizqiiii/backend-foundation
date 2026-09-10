import {
  createEventSchema,
  updateEventSchema,
  listEventsQuerySchema,
  exportEventsQuerySchema,
} from './event.dto';

describe('createEventSchema', () => {
  it('menerima input valid lengkap', () => {
    const result = createEventSchema.parse({
      title: 'Konser musik',
      description: 'Konser amal tahunan',
      category: 'Musik',
      location: 'Jakarta',
      date: '2026-12-01',
    });

    expect(result.title).toBe('Konser musik');
    expect(result.date).toBeInstanceOf(Date);
  });

  it('description bersifat opsional', () => {
    const result = createEventSchema.safeParse({
      title: 'Konser musik',
      category: 'Musik',
      location: 'Jakarta',
      date: '2026-12-01',
    });

    expect(result.success).toBe(true);
  });

  it('menolak title kurang dari 3 karakter', () => {
    const result = createEventSchema.safeParse({
      title: 'ab',
      category: 'Musik',
      location: 'Jakarta',
      date: '2026-12-01',
    });

    expect(result.success).toBe(false);
  });

  it('menolak category kosong', () => {
    const result = createEventSchema.safeParse({
      title: 'Konser musik',
      category: '',
      location: 'Jakarta',
      date: '2026-12-01',
    });

    expect(result.success).toBe(false);
  });

  it('menolak location kosong', () => {
    const result = createEventSchema.safeParse({
      title: 'Konser musik',
      category: 'Musik',
      location: '',
      date: '2026-12-01',
    });

    expect(result.success).toBe(false);
  });

  it('menolak date yang bukan tanggal valid', () => {
    const result = createEventSchema.safeParse({
      title: 'Konser musik',
      category: 'Musik',
      location: 'Jakarta',
      date: 'bukan-tanggal',
    });

    expect(result.success).toBe(false);
  });
});

describe('updateEventSchema', () => {
  it('menerima objek kosong (semua field partial/opsional saat update)', () => {
    const result = updateEventSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('field yang dikirim tetap harus lolos aturan yang sama seperti createEventSchema', () => {
    const result = updateEventSchema.safeParse({ title: 'ab' });
    expect(result.success).toBe(false);
  });

  it('menerima update parsial satu field saja', () => {
    const result = updateEventSchema.parse({ location: 'Bandung' });
    expect(result).toEqual({ location: 'Bandung' });
  });
});

describe('listEventsQuerySchema', () => {
  it('menerapkan default page:1 limit:10 kalau query kosong', () => {
    const result = listEventsQuerySchema.parse({});
    expect(result).toMatchObject({ page: 1, limit: 10 });
  });

  it('meng-coerce page/limit dari string query', () => {
    const result = listEventsQuerySchema.parse({ page: '2', limit: '5' });
    expect(result).toMatchObject({ page: 2, limit: 5 });
  });

  it('menolak limit di atas 100', () => {
    const result = listEventsQuerySchema.safeParse({ limit: '200' });
    expect(result.success).toBe(false);
  });

  it('menerima dateFrom <= dateTo', () => {
    const result = listEventsQuerySchema.safeParse({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
    });
    expect(result.success).toBe(true);
  });

  it('P5 — menolak dateFrom > dateTo lewat .refine cross-field', () => {
    const result = listEventsQuerySchema.safeParse({
      dateFrom: '2026-12-31',
      dateTo: '2026-01-01',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.dateFrom).toBeDefined();
    }
  });

  it('menerima kalau hanya salah satu dari dateFrom/dateTo diisi (refine tidak memaksa keduanya)', () => {
    const result = listEventsQuerySchema.safeParse({ dateFrom: '2026-01-01' });
    expect(result.success).toBe(true);
  });

  it('search/category/location di-trim dan menolak string kosong setelah trim', () => {
    const trimmed = listEventsQuerySchema.parse({ search: '  konser  ' });
    expect(trimmed.search).toBe('konser');

    const emptyAfterTrim = listEventsQuerySchema.safeParse({ search: '   ' });
    expect(emptyAfterTrim.success).toBe(false);
  });
});

describe('exportEventsQuerySchema', () => {
  it('menerima filter yang sama dengan listEventsQuerySchema TANPA page/limit', () => {
    const result = exportEventsQuerySchema.parse({ category: 'Musik' });
    expect(result).not.toHaveProperty('page');
    expect(result).not.toHaveProperty('limit');
    expect(result.category).toBe('Musik');
  });

  it('default format: csv kalau tidak diisi', () => {
    const result = exportEventsQuerySchema.parse({});
    expect(result.format).toBe('csv');
  });

  it('menerima format: xlsx', () => {
    const result = exportEventsQuerySchema.parse({ format: 'xlsx' });
    expect(result.format).toBe('xlsx');
  });

  it('menolak format selain csv/xlsx', () => {
    const result = exportEventsQuerySchema.safeParse({ format: 'pdf' });
    expect(result.success).toBe(false);
  });

  it('P5 — tetap menegakkan validasi dateFrom<=dateTo warisan dari listEventsQuerySchema (via .innerType())', () => {
    const result = exportEventsQuerySchema.safeParse({
      dateFrom: '2026-12-31',
      dateTo: '2026-01-01',
    });
    expect(result.success).toBe(false);
  });
});
