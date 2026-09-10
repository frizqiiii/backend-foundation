import type { Config } from 'jest';
import baseConfig from './jest.config';

/**
 * Config TERPISAH dari `jest.config.ts` (Phase 21 — Contract
 * Testing) — HANYA menjalankan `*.contract.spec.ts`, TANPA
 * `coverageThreshold` (test ini butuh server+database sungguhan,
 * tidak relevan digabung ke angka coverage unit test), dan TANPA
 * `testPathIgnorePatterns` warisan dari base config (yang justru
 * MENGECUALIKAN file contract — di sini kita mau SEBALIKNYA, HANYA
 * file itu yang dijalankan).
 */
const config: Config = {
  ...baseConfig,
  testPathIgnorePatterns: ['/node_modules/'],
  testMatch: ['**/*.contract.spec.ts'],
  coverageThreshold: undefined,
  collectCoverage: false,
};

export default config;
