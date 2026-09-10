import type { Request, Response } from 'express';

/**
 * `prisma`, `redisClient`, `queueConnection` di-mock lewat factory
 * eksplisit — konsisten dengan pola di `upload.service.spec.ts`.
 * Ketiganya di-mock di modul TERPISAH (bukan objek gabungan) karena
 * `health.controller.ts` meng-import masing-masing dari path yang
 * berbeda.
 */
jest.mock('../../../shared/config/database', () => ({
  prisma: { $queryRaw: jest.fn() },
}));
jest.mock('../../../shared/config/redis', () => ({
  redisClient: { ping: jest.fn() },
}));
jest.mock('../../../shared/queue/connection', () => ({
  queueConnection: { ping: jest.fn() },
}));

import { prisma } from '../../../shared/config/database';
import { redisClient } from '../../../shared/config/redis';
import { queueConnection } from '../../../shared/queue/connection';
import { getHealth, getReadiness } from './health.controller';

const mockedQueryRaw = prisma.$queryRaw as unknown as jest.Mock;
const mockedRedisPing = (redisClient as unknown as { ping: jest.Mock }).ping;
const mockedQueuePing = (queueConnection as unknown as { ping: jest.Mock }).ping;

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('Health controller', () => {
  describe('getHealth', () => {
    it('selalu membalas 200 dengan status ok, uptime, dan memory — tanpa menyentuh dependency eksternal', () => {
      const res = createMockResponse();

      getHealth({} as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          uptime: expect.any(Number),
          memory: expect.objectContaining({
            rssMb: expect.any(Number),
            heapUsedMb: expect.any(Number),
            heapTotalMb: expect.any(Number),
          }),
        })
      );
      expect(mockedQueryRaw).not.toHaveBeenCalled();
    });
  });

  describe('getReadiness', () => {
    it('membalas 200 status ready ketika PostgreSQL, Redis, dan Queue semuanya sehat', async () => {
      mockedQueryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      mockedRedisPing.mockResolvedValueOnce('PONG');
      mockedQueuePing.mockResolvedValueOnce('PONG');
      const res = createMockResponse();

      await getReadiness({} as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          checks: expect.objectContaining({
            database: expect.objectContaining({ status: 'ok' }),
            redis: expect.objectContaining({ status: 'ok' }),
            queue: expect.objectContaining({ status: 'ok' }),
          }),
        })
      );
    });

    it('membalas 503 status not_ready ketika PostgreSQL gagal dijangkau — dependency wajib', async () => {
      mockedQueryRaw.mockRejectedValueOnce(new Error('connection refused'));
      mockedRedisPing.mockResolvedValueOnce('PONG');
      mockedQueuePing.mockResolvedValueOnce('PONG');
      const res = createMockResponse();

      await getReadiness({} as Request, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not_ready',
          checks: expect.objectContaining({
            database: expect.objectContaining({ status: 'error' }),
          }),
        })
      );
    });

    it('tetap membalas 200 ready ketika Redis gagal — dependency opsional, bukan wajib', async () => {
      mockedQueryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      mockedRedisPing.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockedQueuePing.mockResolvedValueOnce('PONG');
      const res = createMockResponse();

      await getReadiness({} as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          checks: expect.objectContaining({
            redis: expect.objectContaining({ status: 'error' }),
          }),
        })
      );
    });

    it('P5 — dependency yang MENGGANTUNG (tidak pernah resolve/reject) dianggap gagal setelah timeout 3000ms', async () => {
      jest.useFakeTimers();
      try {
        mockedQueryRaw.mockImplementationOnce(() => new Promise(() => {})); // sengaja tidak pernah resolve
        mockedRedisPing.mockResolvedValueOnce('PONG');
        mockedQueuePing.mockResolvedValueOnce('PONG');
        const res = createMockResponse();

        const readinessPromise = getReadiness({} as Request, res);
        await jest.advanceTimersByTimeAsync(3000);
        await readinessPromise;

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            checks: expect.objectContaining({
              database: expect.objectContaining({ status: 'error' }),
            }),
          })
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('P5 — mengembalikan "Unknown error" kalau yang dilempar dependency BUKAN instance Error (mis. string mentah)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal -- sengaja: mensimulasikan driver yang throw non-Error
      mockedQueryRaw.mockImplementationOnce(() => Promise.reject('bukan Error object'));
      mockedRedisPing.mockResolvedValueOnce('PONG');
      mockedQueuePing.mockResolvedValueOnce('PONG');
      const res = createMockResponse();

      await getReadiness({} as Request, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: expect.objectContaining({
            database: expect.objectContaining({ status: 'error', message: 'Unknown error' }),
          }),
        })
      );
    });

    it('menyertakan message error driver APA ADANYA di luar production (dev/test) — memudahkan debugging lokal', async () => {
      mockedQueryRaw.mockRejectedValueOnce(
        new Error('connection refused: could not connect to server internal-db-01.svc:5432')
      );
      mockedRedisPing.mockResolvedValueOnce('PONG');
      mockedQueuePing.mockResolvedValueOnce('PONG');
      const res = createMockResponse();

      await getReadiness({} as Request, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: expect.objectContaining({
            database: expect.objectContaining({
              message: 'connection refused: could not connect to server internal-db-01.svc:5432',
            }),
          }),
        })
      );
    });

    it('MENYAMARKAN message error driver di production (Finding #23) — endpoint ini PUBLIK tanpa autentikasi, pesan error driver PostgreSQL/Redis/Queue asli bisa memuat hostname/port/detail internal', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalJwtSecret = process.env.JWT_SECRET;
      let getReadinessProd: typeof getReadiness;

      try {
        await jest.isolateModulesAsync(async () => {
          process.env.NODE_ENV = 'production';
          // JWT_SECRET kuat — supaya require ulang `env.ts` di bawah
          // (via chain import health.controller -> logger -> env)
          // tidak ikut memicu `process.exit(1)` gara-gara validasi
          // KEKUATAN secret (lihat `env.spec.ts`) — bukan itu yang
          // sedang diuji di sini.
          process.env.JWT_SECRET = 'a'.repeat(48);

          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const dbMod = require('../../../shared/config/database');
          (dbMod.prisma.$queryRaw as jest.Mock).mockRejectedValueOnce(
            new Error('connection refused: could not connect to server internal-db-01.svc:5432')
          );
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const redisMod = require('../../../shared/config/redis');
          (redisMod.redisClient.ping as jest.Mock).mockResolvedValueOnce('PONG');
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const queueMod = require('../../../shared/queue/connection');
          (queueMod.queueConnection.ping as jest.Mock).mockResolvedValueOnce('PONG');
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const controllerMod = require('./health.controller');
          getReadinessProd = controllerMod.getReadiness;
        });

        const res = createMockResponse();
        await getReadinessProd!({} as Request, res);

        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            checks: expect.objectContaining({
              database: expect.objectContaining({
                status: 'error',
                message: 'Dependency tidak sehat', // BUKAN pesan asli driver
              }),
            }),
          })
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.JWT_SECRET = originalJwtSecret;
      }
    });

    it('P5 — status Redis/Queue "not_configured" (BUKAN "error") kalau memang tidak dikonfigurasi sama sekali (redisClient/queueConnection null), beda dari "gagal terhubung"', async () => {
      // `jest.resetModules()` + `doMock` di sini mempengaruhi registry
      // module GLOBAL (bukan cuma lokal test ini) — makanya test ini
      // SENGAJA ditaruh PALING TERAKHIR di describe block ini, supaya
      // tidak ada test lain SETELAHNYA (di describe ini) yang bisa ikut
      // rusak gara-gara mock `redisClient`/`queueConnection` sudah
      // diganti null. (`isolateModulesAsync` yang biasa dipakai di file
      // lain ternyata tidak konsisten meng-override `jest.mock` yang
      // sudah di-hoist di level file untuk path yang sama.)
      jest.resetModules();
      jest.doMock('../../../shared/config/database', () => ({
        prisma: { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) },
      }));
      jest.doMock('../../../shared/config/redis', () => ({ redisClient: null }));
      jest.doMock('../../../shared/queue/connection', () => ({ queueConnection: null }));
      const controllerMod = require('./health.controller');

      const res = createMockResponse();
      await controllerMod.getReadiness({} as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          checks: expect.objectContaining({
            redis: { status: 'not_configured' },
            queue: { status: 'not_configured' },
          }),
        })
      );
    });
  });
});

describe('setShuttingDown', () => {
  it('P5 — setelah dipanggil, getReadiness LANGSUNG membalas 503 "Proses sedang shutdown" TANPA menyentuh dependency (database/Redis/queue) sama sekali', async () => {
    let getReadinessAfterShutdown: typeof getReadiness;
    let setShuttingDownFn: () => void;

    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../../shared/config/database', () => ({
        prisma: { $queryRaw: jest.fn() },
      }));
      jest.doMock('../../../shared/config/redis', () => ({
        redisClient: { ping: jest.fn() },
      }));
      jest.doMock('../../../shared/queue/connection', () => ({
        queueConnection: { ping: jest.fn() },
      }));
      const controllerMod = require('./health.controller');
      getReadinessAfterShutdown = controllerMod.getReadiness;
      setShuttingDownFn = controllerMod.setShuttingDown;

      setShuttingDownFn();
      const res = createMockResponse();

      await getReadinessAfterShutdown({} as Request, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'not_ready', message: 'Proses sedang shutdown' })
      );
      // database/redis/queue TIDAK di-mock dengan implementasi spesifik
      // di sini — kalau getReadiness sempat menyentuhnya, mock default
      // jest.fn() (mengembalikan undefined, bukan Promise) akan
      // membuat request ini gagal/timeout alih-alih langsung 503.
    });
  });
});
