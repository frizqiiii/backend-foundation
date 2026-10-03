import net from 'net';
import Redis from 'ioredis';

jest.mock('../logger', () => ({ logger: { warn: jest.fn() } }));

import { logger } from '../logger';

const mockedWarn = logger.warn as unknown as jest.Mock;

type SafeEnqueueModule = typeof import('./safe-enqueue');

async function load(connection: unknown): Promise<SafeEnqueueModule> {
  let mod: SafeEnqueueModule | undefined;
  await jest.isolateModulesAsync(async () => {
    jest.doMock('./connection', () => ({ queueConnection: connection }));
    mod = require('./safe-enqueue');
  });
  return mod!;
}

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

describe('tryEnqueue', () => {
  beforeEach(() => mockedWarn.mockClear());

  it('queue null (Redis tidak dikonfigurasi) → false, pemanggil memakai fallback sinkron', async () => {
    const { tryEnqueue } = await load(null);
    await expect(tryEnqueue(null, 'x', {})).resolves.toBe(false);
  });

  it('add() berhasil → true dengan argumen yang diteruskan apa adanya', async () => {
    const { tryEnqueue } = await load({ status: 'ready' });
    const add = jest.fn().mockResolvedValue({ id: '1' });

    await expect(tryEnqueue({ add }, 'verification', { to: 'a@b.c' })).resolves.toBe(true);

    expect(add).toHaveBeenCalledWith('verification', { to: 'a@b.c' });
    expect(mockedWarn).not.toHaveBeenCalled();
  });

  it('status tidak diketahui (mis. mock tanpa properti status) → tetap dicoba', async () => {
    const { tryEnqueue } = await load({});
    const add = jest.fn().mockResolvedValue(undefined);

    await expect(tryEnqueue({ add }, 'x', {})).resolves.toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('REDIS MATI (status bukan "ready") → add() TIDAK dipanggil sama sekali, langsung false', async () => {
    const { tryEnqueue } = await load({ status: 'reconnecting' });
    const add = jest.fn(() => new Promise<never>(() => {})); // akan menggantung kalau dipanggil

    await expect(tryEnqueue({ add }, 'x', {})).resolves.toBe(false);

    expect(add).not.toHaveBeenCalled();
    expect(mockedWarn).toHaveBeenCalledTimes(1);
  });

  it('add() MELEMPAR error → dicatat sebagai warning, false (tidak melempar ke pemanggil)', async () => {
    const { tryEnqueue } = await load({ status: 'ready' });
    const add = jest.fn().mockRejectedValue(new Error('OOM command not allowed'));

    await expect(tryEnqueue({ add }, 'x', {})).resolves.toBe(false);
    expect(mockedWarn).toHaveBeenCalledTimes(1);
  });

  it('koneksi "ready" tapi add() MENGGANTUNG → false setelah ENQUEUE_TIMEOUT_MS, bukan menunggu selamanya', async () => {
    jest.useFakeTimers();
    try {
      const { tryEnqueue, ENQUEUE_TIMEOUT_MS } = await load({ status: 'ready' });
      const add = jest.fn(() => new Promise<never>(() => {}));

      const result = tryEnqueue({ add }, 'x', {});
      await jest.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);

      await expect(result).resolves.toBe(false);
      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('timeout enqueue JAUH di bawah timeout klien/ingress yang umum', async () => {
    const { ENQUEUE_TIMEOUT_MS } = await load(null);
    expect(ENQUEUE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it('REGRESI NYATA — ioredis sungguhan ke Redis yang mati: statusnya bukan "ready", jadi add() tidak dipanggil dan hasilnya langsung false', async () => {
    const port = await getClosedPort();
    const client = new Redis(`redis://127.0.0.1:${port}`, {
      maxRetriesPerRequest: null,
      connectTimeout: 200,
    });
    client.on('error', () => {});
    await new Promise((resolve) => setTimeout(resolve, 150)); // beri waktu satu percobaan koneksi gagal

    const { tryEnqueue } = await load(client);
    const add = jest.fn(() => new Promise<never>(() => {}));
    const startedAt = Date.now();

    await expect(tryEnqueue({ add }, 'x', {})).resolves.toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(add).not.toHaveBeenCalled();
    expect(client.status).not.toBe('ready');
    client.disconnect();
  }, 10000);
});
