import { enforcePartnerApiGatewayLimit } from './api-key-gateway';
import { redisClient } from '../config/redis';
import { partnerApiRequestsTotal } from '../../modules/monitoring/metrics/metrics.registry';
import { TooManyRequestsError } from '../utils/http-error';

jest.mock('../config/redis', () => ({ redisClient: { incr: jest.fn(), expire: jest.fn() } }));
jest.mock('../../modules/monitoring/metrics/metrics.registry', () => ({
  partnerApiRequestsTotal: { inc: jest.fn() },
}));

const mockedRedis = redisClient as unknown as { incr: jest.Mock; expire: jest.Mock };
const mockedInc = partnerApiRequestsTotal.inc as jest.Mock;

describe('enforcePartnerApiGatewayLimit (item 2.10 — API Gateway edge)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mengizinkan (allowed) request pertama, TTL diset SEKALI di request pertama window', async () => {
    mockedRedis.incr.mockResolvedValue(1);

    await enforcePartnerApiGatewayLimit('key-1');

    expect(mockedRedis.incr).toHaveBeenCalledWith('api-gateway:apikey:key-1');
    expect(mockedRedis.expire).toHaveBeenCalledWith('api-gateway:apikey:key-1', 60);
    expect(mockedInc).toHaveBeenCalledWith({ outcome: 'allowed' });
  });

  it('TIDAK mengeset ulang TTL di request KEDUA dst dalam window yang sama (mencegah window bergeser maju terus)', async () => {
    mockedRedis.incr.mockResolvedValue(5);

    await enforcePartnerApiGatewayLimit('key-1');

    expect(mockedRedis.expire).not.toHaveBeenCalled();
  });

  it('menolak (TooManyRequestsError) begitu melewati batas per menit', async () => {
    mockedRedis.incr.mockResolvedValue(301); // > default 300

    await expect(enforcePartnerApiGatewayLimit('key-1')).rejects.toThrow(TooManyRequestsError);
    expect(mockedInc).toHaveBeenCalledWith({ outcome: 'rejected' });
  });

  it('PERSIS di batas (300) masih diizinkan — baru ditolak di 301', async () => {
    mockedRedis.incr.mockResolvedValue(300);

    await expect(enforcePartnerApiGatewayLimit('key-1')).resolves.toBeUndefined();
    expect(mockedInc).toHaveBeenCalledWith({ outcome: 'allowed' });
  });

  it('fail-open kalau Redis melempar error — TIDAK menolak request, tetap tercatat ke metric', async () => {
    mockedRedis.incr.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(enforcePartnerApiGatewayLimit('key-1')).resolves.toBeUndefined();
    expect(mockedInc).toHaveBeenCalledWith({ outcome: 'allowed_redis_error' });
  });

  it('kuota diisolasi PER API KEY — key berbeda punya hitungan terpisah', async () => {
    mockedRedis.incr.mockResolvedValue(1);

    await enforcePartnerApiGatewayLimit('key-A');
    await enforcePartnerApiGatewayLimit('key-B');

    expect(mockedRedis.incr).toHaveBeenCalledWith('api-gateway:apikey:key-A');
    expect(mockedRedis.incr).toHaveBeenCalledWith('api-gateway:apikey:key-B');
  });

  describe('item 2.11 — kuota per-tier/plan', () => {
    it('FREE: 60/menit — 60 masih lolos, 61 ditolak', async () => {
      mockedRedis.incr.mockResolvedValue(60);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'FREE')).resolves.toBeUndefined();

      mockedRedis.incr.mockResolvedValue(61);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'FREE')).rejects.toThrow(
        TooManyRequestsError
      );
      expect(mockedInc).toHaveBeenLastCalledWith({ outcome: 'rejected' });
    });

    it('PRO: tetap 300/menit (angka lama) — 301 ditolak', async () => {
      mockedRedis.incr.mockResolvedValue(301);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'PRO')).rejects.toThrow(
        TooManyRequestsError
      );
    });

    it('ENTERPRISE: 1200/menit — 301 yang ditolak di PRO/default masih lolos di sini, 1201 ditolak', async () => {
      mockedRedis.incr.mockResolvedValue(301);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'ENTERPRISE')).resolves.toBeUndefined();

      mockedRedis.incr.mockResolvedValue(1200);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'ENTERPRISE')).resolves.toBeUndefined();

      mockedRedis.incr.mockResolvedValue(1201);
      await expect(enforcePartnerApiGatewayLimit('key-1', 'ENTERPRISE')).rejects.toThrow(
        TooManyRequestsError
      );
    });

    it.each([null, undefined, 'GOLD'])(
      'plan tidak diketahui (%p) -> tier default (PRO, angka lama 300), BUKAN error dan BUKAN blokir',
      async (plan) => {
        mockedRedis.incr.mockResolvedValue(300);
        await expect(enforcePartnerApiGatewayLimit('key-1', plan)).resolves.toBeUndefined();

        mockedRedis.incr.mockResolvedValue(301);
        await expect(enforcePartnerApiGatewayLimit('key-1', plan)).rejects.toThrow(
          TooManyRequestsError
        );
      }
    );

    it('pesan error memuat angka kuota tier yang berlaku (bukan angka global)', async () => {
      mockedRedis.incr.mockResolvedValue(61);

      await expect(enforcePartnerApiGatewayLimit('key-1', 'FREE')).rejects.toThrow(
        /maks 60 request\/menit/
      );
    });

    it('perubahan plan berlaku di request berikutnya TANPA mereset hitungan window yang sedang berjalan', async () => {
      // 100 request sudah tercatat di window ini (Redis key sama).
      mockedRedis.incr.mockResolvedValue(100);

      // Sebagai FREE (60) — sudah melewati kuota.
      await expect(enforcePartnerApiGatewayLimit('key-1', 'FREE')).rejects.toThrow(
        TooManyRequestsError
      );
      // Setelah di-upgrade ke PRO — hitungan yang SAMA (100) kini lolos.
      await expect(enforcePartnerApiGatewayLimit('key-1', 'PRO')).resolves.toBeUndefined();
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
