import net from 'net';
import Redis from 'ioredis';

jest.mock('../logger', () => ({ logger: { warn: jest.fn() } }));

import { logger } from '../logger';
import { quietRedisQuit, REDIS_QUIT_TIMEOUT_MS } from './redis-shutdown';

const mockedWarn = logger.warn as unknown as jest.Mock;

/** Port yang DIJAMIN tertutup: buka server di port acak, catat port-nya, lalu tutup lagi. */
async function getClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe('quietRedisQuit', () => {
  beforeEach(() => mockedWarn.mockClear());

  it('tidak melakukan apa pun kalau koneksinya null (Redis tidak dikonfigurasi)', async () => {
    await expect(quietRedisQuit('cache', null)).resolves.toBeUndefined();
    expect(mockedWarn).not.toHaveBeenCalled();
  });

  it('quit() berhasil → tidak ada warning dan tidak ada disconnect paksa', async () => {
    const client = { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };

    await quietRedisQuit('cache', client);

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(mockedWarn).not.toHaveBeenCalled();
  });

  it('quit() MELEMPAR (mis. "Connection is closed.") → dicatat sebagai warning, disconnect dipanggil, TIDAK melempar', async () => {
    const client = {
      quit: jest.fn().mockRejectedValue(new Error('Connection is closed.')),
      disconnect: jest.fn(),
    };

    await expect(quietRedisQuit('queue', client)).resolves.toBeUndefined();

    expect(mockedWarn).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('quit() MENGGANTUNG → diputus paksa setelah timeout, bukan menunggu selamanya', async () => {
    jest.useFakeTimers();
    try {
      const client = { quit: jest.fn(() => new Promise<never>(() => {})), disconnect: jest.fn() };

      const done = quietRedisQuit('queue', client, 2000);
      await jest.advanceTimersByTimeAsync(2000);
      await done;

      expect(client.disconnect).toHaveBeenCalledTimes(1);
      expect(mockedWarn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('timeout default JAUH di bawah SHUTDOWN_TIMEOUT_MS bawaan (10000ms)', () => {
    expect(REDIS_QUIT_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it('REGRESI NYATA — ioredis sungguhan (maxRetriesPerRequest:null) ke Redis yang mati, dengan ping() mengantre seperti /ready: quit() selesai dalam batas waktu', async () => {
    const port = await getClosedPort();
    const client = new Redis(`redis://127.0.0.1:${port}`, { maxRetriesPerRequest: null });
    client.on('error', () => {});
    // Meniru `/ready` / kolektor `/metrics`: perintah yang mengantre di offline queue dan tidak pernah selesai.
    client.ping().catch(() => {});

    const startedAt = Date.now();
    await quietRedisQuit('queue', client, 300);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(3000);
    expect(mockedWarn).toHaveBeenCalledTimes(1);
    // Beri event loop satu putaran supaya socket yang baru diputus selesai dibersihkan sebelum test berakhir.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }, 10000);
});
