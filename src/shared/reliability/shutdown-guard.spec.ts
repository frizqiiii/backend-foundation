import { createGuardedShutdown } from './shutdown-guard';

describe('createGuardedShutdown', () => {
  it('menjalankan handler saat dipanggil pertama kali', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const onDuplicate = jest.fn();
    const shutdown = createGuardedShutdown(handler, onDuplicate);

    await shutdown('SIGTERM');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('SIGTERM');
    expect(onDuplicate).not.toHaveBeenCalled();
  });

  it('TIDAK menjalankan handler lagi kalau dipanggil kedua kali SETELAH yang pertama selesai', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const onDuplicate = jest.fn();
    const shutdown = createGuardedShutdown(handler, onDuplicate);

    await shutdown('SIGTERM');
    await shutdown('SIGINT');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith('SIGINT');
  });

  it('TIDAK menjalankan handler dua kali kalau dipanggil BERSAMAAN (concurrent) — mensimulasikan SIGTERM & uncaughtException yang datang berdekatan', async () => {
    let resolveHandler: () => void;
    const handler = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        })
    );
    const onDuplicate = jest.fn();
    const shutdown = createGuardedShutdown(handler, onDuplicate);

    // Dua pemanggilan konkuren SEBELUM handler pertama selesai —
    // ini persis skenario race condition yang jadi alasan guard ini
    // dibuat (lihat komentar di shutdown-guard.ts).
    const firstCall = shutdown('SIGTERM');
    const secondCall = shutdown('uncaughtException');

    resolveHandler!();
    await Promise.all([firstCall, secondCall]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith('uncaughtException');
  });

  it('meneruskan error dari handler ke pemanggil (tidak menelan exception)', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('gagal disconnect'));
    const shutdown = createGuardedShutdown(handler, jest.fn());

    await expect(shutdown('SIGTERM')).rejects.toThrow('gagal disconnect');
  });
});
