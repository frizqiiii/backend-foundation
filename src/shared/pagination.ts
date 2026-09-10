/**
 * Helper pagination generik — dipakai lintas modul (Events, dan modul
 * lain di masa depan) agar logika `skip`/`take` tidak diduplikasi per
 * modul. Sebelumnya ada versi duplikat khusus event
 * (`event.pagination.ts`, sudah dihapus saat konsolidasi) yang
 * melakukan hal yang sama plus parsing query string — parsing query
 * (page/limit dari `req.query`) sebaiknya tetap jadi tanggung jawab
 * Controller masing-masing modul, bukan helper generik ini.
 */
export interface PaginationParams {
  skip: number;
  take: number;
}

export function pagination(page: number, limit: number): PaginationParams {
  return {
    skip: (page - 1) * limit,
    take: limit,
  };
}

/**
 * Bentuk response generik untuk endpoint list yang di-paginasi —
 * dipakai pertama kali oleh Events (#3), bisa dipakai ulang modul
 * lain di masa depan tanpa setiap modul menemukan ulang bentuk
 * metadata-nya sendiri.
 */
export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function buildPaginatedResult<T>(
  data: T[],
  total: number,
  page: number,
  limit: number
): PaginatedResult<T> {
  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}
