export interface DailyActiveUsersDto {
  /** Jumlah hari yang diminta (echo dari query param, memudahkan konsumen memvalidasi response-nya sendiri). */
  days: number;
  /** Terurut tanggal menaik, hari tanpa login tetap muncul dengan count 0. */
  data: Array<{ date: string; count: number }>;
}
