import { enforcePartnerApiGatewayLimit } from './api-key-gateway';
import { partnerApiRequestsTotal } from '../../modules/monitoring/metrics/metrics.registry';
import { TooManyRequestsError } from '../utils/http-error';

// Temuan T18 — hitungan + TTL lewat satu `MULTI SET NX EX + INCR EXEC` atomik, bukan `incr` lalu `expire`.
const mockChain = { set: jest.fn(), incr: jest.fn(), exec: jest.fn() };
jest.mock('../config/redis', () => ({ redisClient: { multi: jest.fn(() => mockChain) } }));

/** `EXEC` mengembalikan `[[err, hasilSET], [err, hasilINCR]]`; hasilINCR = hitungan setelah increment. */
function mockCount(count: number): void {
  mockChain.set.mockReturnValue(mockChain);
  mockChain.incr.mockReturnValue(mockChain);
  mockChain.exec.mockResolvedValue([
    [null, count === 1 ? 'OK' : null],
    [null, count],
  ]);
}
jest.mock('../../modules/monitoring/metrics/metrics.registry', () => ({
  partnerApiRequestsTotal: { inc: jest.fn() },
}));

const mockedInc = partnerApiRequestsTotal.inc as jest.Mock;

describe('enforcePartnerApiGatewayLimit (item 2.10 — API Gateway edge)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mengizinkan (allowed) request pertama, TTL diset SEKALI di request pertama window', async () => {
    mockCount(1);

    await enforcePartnerApiGatewayLimit('key-1');

    expect(mockChain.incr).toHaveBeenCalledWith('api-gateway:apikey:key-1');
    // TTL 60 dtk dibuat ATOMIK bersama kunci: SET key 0 EX 60 NX (NX = tidak menggeser window yang sedang berjalan).
    expect(mockChain.set).toHaveBeenCalledWith('api-gateway:apikey:key-1', 0, 'EX', 60, 'NX');
    expect(mockedInc).toHaveBeenCalledWith({ outcome: 'allowed' });
  });

  it('TIDAK mengeset ulang TTL di request KEDUA dst dalam window yang sama (mencegah window bergeser maju terus)', async () => {
    mockCount(5);

    await enforcePartnerApiGatewayLimit('key-1');

    // `NX` di setiap panggilan = TTL hanya dibuat bila kunci belum ada; window yang berjalan tidak bergeser.
    expect(mockChain.set).toHaveBeenCalledWith('api-gateway:apikey:key-1', 0, 'EX', 60, 'NX');
  });

  it('menolak (TooManyRequestsError) begitu melewati batas per menit', async () => {
    mockCount(301); // > default 300

    await expect(enforcePartnerApiGatewayLimit('key-1')).rejects.toThrow(TooManyRequestsError);
    expect(mockedInc).toHaveBeenCalledWith({ outcome: 'rejected' });
  });

  it('PERSIS di batas (300) masih diizinkan — baru ditolak di 301', async () => {
    mockCount(300);

    await expect(enforcePartnerApiGatewayLimit('key-1')).resolves.toBeUndefined();
    expect(mockedInc).toHaveBeenCalledWith({ outcome: 'allowed' });
  });

  it('fail-open kalau Redis melempar error — TIDAK menolak request, tetap tercatat ke metric', async () => {
    mockChain.exec.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(enforcePartnerApiGatewayLimit('key-1')).resolves.toBeUndefined();
    expect(mockedInc).toHaveBeenCalledWith({ outcome: 'allowed_redis_error' });
  });

  it('kuota diisolasi PER API KEY — key berbeda punya hitungan terpisah', async () => {
    mockCount(1);

    await enforcePartnerApiGatewayLimit('key-A');
    await enforcePartnerApiGatewayLimit('key-B');

    expect(mockChain.incr).toHaveBeenCalledWith('api-gateway:apikey:key-A');
    expect(mockChain.incr).toHaveBeenCalledWith('api-gateway:apikey:key-B');
  });

  describe('item 2.11 — kuota per-tier/plan', () => {
    it('FREE: 60/menit — 60 masih lolos, 61 ditolak', async () => {
      mockCount(60);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'FREE')).resolves.toBeUndefined();

      mockCount(61);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'FREE')).rejects.toThrow(
        TooManyRequestsError
      );
      expect(mockedInc).toHaveBeenLastCalledWith({ outcome: 'rejected' });
    });

    it('PRO: tetap 300/menit (angka lama) — 301 ditolak', async () => {
      mockCount(301);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'PRO')).rejects.toThrow(
        TooManyRequestsError
      );
    });

    it('ENTERPRISE: 1200/menit — 301 yang ditolak di PRO/default masih lolos di sini, 1201 ditolak', async () => {
      mockCount(301);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'ENTERPRISE')).resolves.toBeUndefined();

      mockCount(1200);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'ENTERPRISE')).resolves.toBeUndefined();

      mockCount(1201);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'ENTERPRISE')).rejects.toThrow(
        TooManyRequestsError
      );
    });

    it.each([null, undefined, 'GOLD'])(
      'plan tidak diketahui (%p) -> tier default (PRO, angka lama 300), BUKAN error dan BUKAN blokir',
      async (plan) => {
        mockCount(300);
        await expect(enforcePartnerApiGatewayLimit('key-1', plan)).resolves.toBeUndefined();

        mockCount(301);
        await expect(enforcePartnerApiGatewayLimit('key-1', plan)).rejects.toThrow(
          TooManyRequestsError
        );
      }
    );

    it('pesan error memuat angka kuota tier yang berlaku (bukan angka global)', async () => {
      mockCount(61);

      await expect(enforcePartnerApiGatewayLimit('key-1', 'FREE')).rejects.toThrow(
        /maks 60 request\/menit/
      );
    });

    it('perubahan plan berlaku di request berikutnya TANPA mereset hitungan window yang sedang berjalan', async () => {
      // 100 request sudah tercatat di window ini (Redis key sama).
      mockCount(100);

      // Sebagai FREE (60) — sudah melewati kuota.
      await expect(enforcePartnerApiGatewayLimit('key-1', 'FREE')).rejects.toThrow(
        TooManyRequestsError
      );
      // Setelah di-upgrade ke PRO — hitungan yang SAMA (100) kini lolos.
      await expect(enforcePartnerApiGatewayLimit('key-1', 'PRO')).resolves.toBeUndefined();
    });
  });

  describe('temuan T18 — kuota tidak boleh tersangkut tanpa TTL', () => {
    /**
     * Redis tiruan yang menyimpan hitungan DAN TTL per kunci, dan mengeksekusi `MULTI/EXEC` secara atomik
     * (SET NX EX lalu INCR). `advance` memajukan waktu. Model TTL-nya dicocokkan dengan Redis 7 sungguhan.
     */
    function installFakeRedis() {
      const store = new Map<string, { value: number; ttl: number | null }>();
      const { redisClient } = jest.requireMock('../config/redis') as {
        redisClient: { multi: jest.Mock; expire?: jest.Mock; incr?: jest.Mock };
      };
      // Perintah terpisah SENGAJA rusak: kegagalan sementara yang menjebak pola lama.
      redisClient.expire = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      redisClient.incr = undefined;
      redisClient.multi.mockImplementation(() => {
        const commands: Array<() => unknown> = [];
        const chain = {
          set: (key: string, value: number, _ex: string, seconds: number, _nx: string) => {
            commands.push(() => {
              if (store.has(key)) {
                return null; // NX: kunci sudah ada -> tidak diubah (TTL tidak bergeser)
              }
              store.set(key, { value, ttl: seconds });
              return 'OK';
            });
            return chain;
          },
          incr: (key: string) => {
            commands.push(() => {
              const entry = store.get(key) ?? { value: 0, ttl: null };
              entry.value += 1;
              store.set(key, entry);
              return entry.value;
            });
            return chain;
          },
          exec: async () => commands.map((run) => [null, run()]),
        };
        return chain;
      });
      const advance = (seconds: number): void => {
        for (const [key, entry] of store) {
          if (entry.ttl !== null && entry.ttl - seconds <= 0) {
            store.delete(key);
          } else if (entry.ttl !== null) {
            entry.ttl -= seconds;
          }
        }
      };
      return { store, advance };
    }

    const KEY = 'api-gateway:apikey:key-t18';

    it('kunci SELALU punya TTL sejak request pertama, walau perintah EXPIRE terpisah akan gagal (pola lama meninggalkan TTL -1 selamanya)', async () => {
      const { store } = installFakeRedis();

      for (let i = 0; i < 5; i += 1) {
        await enforcePartnerApiGatewayLimit('key-t18');
      }

      expect(store.get(KEY)).toEqual({ value: 5, ttl: 60 });
    });

    it('window TIDAK bergeser: request berikutnya tidak mengubah TTL yang sedang berjalan (NX)', async () => {
      const { store, advance } = installFakeRedis();
      await enforcePartnerApiGatewayLimit('key-t18');
      advance(50); // sisa TTL 10 detik

      await enforcePartnerApiGatewayLimit('key-t18');

      expect(store.get(KEY)).toEqual({ value: 2, ttl: 10 });
    });

    it('API key yang sudah ditolak DIIZINKAN LAGI begitu window habis (hitungan mulai dari 1, bukan tersangkut permanen)', async () => {
      const { advance } = installFakeRedis();
      for (let i = 0; i < 300; i += 1) {
        await enforcePartnerApiGatewayLimit('key-t18');
      }
      await expect(enforcePartnerApiGatewayLimit('key-t18')).rejects.toThrow(TooManyRequestsError);

      advance(61);

      await expect(enforcePartnerApiGatewayLimit('key-t18')).resolves.toBeUndefined();
    });
  });
});

describe('enforcePartnerApiGatewayLimit — tanpa Redis dikonfigurasi sama sekali', () => {
  it('fail-open TANPA mencoba akses Redis sama sekali', async () => {
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../config/redis', () => ({ redisClient: null }));
      jest.doMock('../../modules/monitoring/metrics/metrics.registry', () => ({
        partnerApiRequestsTotal: { inc: jest.fn() },
      }));
      const { enforcePartnerApiGatewayLimit: fn } = await import('./api-key-gateway');
      const { partnerApiRequestsTotal: metric } =
        await import('../../modules/monitoring/metrics/metrics.registry');

      await expect(fn('key-1')).resolves.toBeUndefined();
      expect(metric.inc as jest.Mock).toHaveBeenCalledWith({ outcome: 'allowed_no_redis' });
    });
  });
});
