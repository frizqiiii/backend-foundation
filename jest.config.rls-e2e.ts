import type { Config } from 'jest';
import baseConfig from './jest.config';

/**
 * Config TERPISAH khusus `rls-bypass.e2e.spec.ts` (Fase 4, RLS) —
 * lihat komentar di `jest.setup.rls-e2e.ts` untuk alasan lengkapnya.
 * Dijalankan lewat `npm run test:rls`, BUKAN bagian dari `npm test`
 * biasa (file spec-nya sendiri sudah dikecualikan dari
 * `testPathIgnorePatterns` di `jest.config.ts`).
 */
const config: Config = {
  ...baseConfig,
  testMatch: ['**/rls-bypass.e2e.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  setupFiles: ['<rootDir>/jest.setup.rls-e2e.ts'],
  collectCoverage: false,
};

export default config;
