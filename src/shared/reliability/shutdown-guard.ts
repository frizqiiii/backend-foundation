/**
 * Guard anti-double-shutdown (P0 hardening — reliability audit).
 *
 * `server.ts` dan `worker.ts` masing-masing punya banyak jalur yang
 * bisa memicu shutdown: sinyal OS (`SIGTERM`/`SIGINT`) dan sekarang
 * juga `uncaughtException`/`unhandledRejection`. Tanpa guard, dua
 * jalur ini bisa memanggil fungsi shutdown yang sama secara PARALEL
 * (mis. `SIGTERM` datang tepat saat exception yang tidak tertangani
 * juga memicu shutdown) — `httpServer.close()`/`worker.close()` dan
 * `$disconnect()` akan dipanggil dobel, berpotensi race condition
 * yang membingungkan saat debugging insiden produksi.
 *
 * Diekstrak jadi fungsi murni terpisah (bukan tetap inline duplikat
 * di dua file) supaya perilakunya bisa diuji langsung tanpa perlu
 * menjalankan `server.ts`/`worker.ts` sungguhan (yang punya efek
 * samping proses nyata — `app.listen`, koneksi Redis/DB, dst — saat
 * di-import).
 */
export function createGuardedShutdown(
  handler: (signal: string) => Promise<void>,
  onDuplicate: (signal: string) => void
): (signal: string) => Promise<void> {
  let isShuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      onDuplicate(signal);
      return;
    }
    isShuttingDown = true;
    await handler(signal);
  };
}
