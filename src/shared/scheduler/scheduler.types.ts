/**
 * Kontrak yang harus dipenuhi setiap scheduled job — file terpisah
 * (bukan didefinisikan inline di `index.ts`) supaya file job individual
 * (`jobs/*.job.ts`) bisa meng-import tipe ini tanpa circular dependency
 * balik ke `index.ts` (yang justru meng-import SEMUA job).
 */
export interface ScheduledJobDefinition {
  /** Nama unik job — dipakai di log & sebagai key metric, HARUS singkat & jelas (mis. "cleanup-expired-refresh-tokens"). */
  name: string;
  /**
   * Cron expression standar 5-field (`menit jam tanggal bulan hari`).
   * Lihat masing-masing file job untuk alasan jadwal yang dipilih.
   */
  cronExpression: string;
  /**
   * Handler job — mengembalikan ringkasan singkat hasil eksekusi
   * (mis. jumlah baris yang dihapus) untuk dicatat di log. TIDAK
   * boleh menelan error sendiri — biarkan runner (`job-runner.ts`)
   * yang menangani retry & logging kegagalan secara seragam.
   */
  run: () => Promise<JobRunSummary>;
}

export interface JobRunSummary {
  /** Ringkasan singkat dalam satu baris untuk log, mis. "12 refresh token dihapus". */
  message: string;
  /** Detail terstruktur opsional (jumlah baris per tabel, dst) untuk konteks tambahan di log. */
  details?: Record<string, number>;
}
