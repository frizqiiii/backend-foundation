import { env } from '../config/env';
import {
  DEFAULT_TENANT_PLAN,
  getRateLimitTier,
  isTenantPlanName,
  type TenantPlanName,
} from './rate-limit-tiers';

describe('rate-limit-tiers (item 2.11)', () => {
  describe('getRateLimitTier', () => {
    it('setiap plan punya kuota berbeda dan berurutan: FREE < PRO < ENTERPRISE (per tenant DAN per API key)', () => {
      const free = getRateLimitTier('FREE');
      const pro = getRateLimitTier('PRO');
      const enterprise = getRateLimitTier('ENTERPRISE');

      expect(free.tenantRequestsPer15Min).toBeLessThan(pro.tenantRequestsPer15Min);
      expect(pro.tenantRequestsPer15Min).toBeLessThan(enterprise.tenantRequestsPer15Min);
      expect(free.apiKeyRequestsPerMinute).toBeLessThan(pro.apiKeyRequestsPerMinute);
      expect(pro.apiKeyRequestsPerMinute).toBeLessThan(enterprise.apiKeyRequestsPerMinute);
    });

    it('BACKWARD COMPATIBLE — PRO persis sama dengan angka flat sebelum item 2.11 (1000/15 menit per tenant, API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE per key)', () => {
      expect(getRateLimitTier('PRO')).toEqual({
        tenantRequestsPer15Min: 1000,
        apiKeyRequestsPerMinute: env.API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE,
      });
    });

    it('nilai konkret tiap tier (dikunci di test supaya perubahan angka disengaja, bukan tidak sengaja)', () => {
      expect(getRateLimitTier('FREE')).toEqual({
        tenantRequestsPer15Min: 200,
        apiKeyRequestsPerMinute: 60,
      });
      expect(getRateLimitTier('ENTERPRISE')).toEqual({
        tenantRequestsPer15Min: 5000,
        apiKeyRequestsPerMinute: 1200,
      });
    });

    it.each([null, undefined, '', 'GOLD', 'pro', 42, {}])(
      'plan tidak dikenal/kosong (%p) TIDAK melempar — jatuh ke tier default (perilaku lama)',
      (plan) => {
        expect(getRateLimitTier(plan)).toEqual(getRateLimitTier(DEFAULT_TENANT_PLAN));
      }
    );

    it('tier PRO mengikuti API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE saat env berubah (dibaca lazy, bukan dibekukan saat import)', () => {
      // `env` asli (envalid) IMMUTABLE — mutasi langsung melempar
      // TypeError — jadi objek di-mock mutable khusus di test ini.
      jest.isolateModules(() => {
        jest.doMock('../config/env', () => ({
          env: { API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE: 777 },
        }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const isolated = require('./rate-limit-tiers') as typeof import('./rate-limit-tiers');

        expect(isolated.getRateLimitTier('PRO').apiKeyRequestsPerMinute).toBe(777);
        // FREE/ENTERPRISE TIDAK ikut berubah
        expect(isolated.getRateLimitTier('FREE').apiKeyRequestsPerMinute).toBe(60);
        expect(isolated.getRateLimitTier('ENTERPRISE').apiKeyRequestsPerMinute).toBe(1200);
      });
    });
  });

  it('DEFAULT_TENANT_PLAN adalah PRO (angka lama), bukan FREE', () => {
    expect(DEFAULT_TENANT_PLAN).toBe('PRO');
  });

  describe('isTenantPlanName', () => {
    it('true hanya untuk 3 nilai valid, case-sensitive', () => {
      const valid: TenantPlanName[] = ['FREE', 'PRO', 'ENTERPRISE'];
      valid.forEach((p) => expect(isTenantPlanName(p)).toBe(true));
      expect(isTenantPlanName('free')).toBe(false);
      expect(isTenantPlanName(null)).toBe(false);
    });
  });
});
