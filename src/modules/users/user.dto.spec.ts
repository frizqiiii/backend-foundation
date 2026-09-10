import { listUsersQuerySchema } from './user.dto';

describe('listUsersQuerySchema', () => {
  it('menerapkan default page:1 limit:20 kalau query kosong', () => {
    expect(listUsersQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it('meng-coerce page/limit dari string query', () => {
    expect(listUsersQuerySchema.parse({ page: '3', limit: '15' })).toEqual({ page: 3, limit: 15 });
  });

  it('menolak limit di atas 100', () => {
    expect(listUsersQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('menolak page kurang dari 1', () => {
    expect(listUsersQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('menolak limit kurang dari 1', () => {
    expect(listUsersQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('menolak page/limit yang bukan angka', () => {
    expect(listUsersQuerySchema.safeParse({ page: 'abc' }).success).toBe(false);
  });
});
