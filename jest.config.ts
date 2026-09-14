import type { Config } from 'jest';

/**
 * Konfigurasi Jest untuk unit testing TypeScript.
 *
 * - `ts-jest` mengompilasi file `.ts` on-the-fly tanpa perlu build
 *   terpisah sebelum test dijalankan.
 * - `testEnvironment: 'node'` karena ini backend murni (bukan DOM).
 * - Pola file test: `*.spec.ts` atau `*.test.ts`, boleh diletakkan
 *   bersebelahan dengan source-nya (co-located) di dalam `src/`.
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.contract\\.spec\\.ts$',
    // Fase 4 (RLS) — SATU-SATUNYA test di project ini yang butuh
    // koneksi database SUNGGUHAN (bukan mock). Dikeluarkan dari run
    // normal (yang pakai DATABASE_URL dummy dari `jest.setup.ts`) —
    // punya config & database sendiri, lihat `jest.config.rls-e2e.ts`
    // + script `test:rls` di `package.json`.
    'rls-bypass\\.e2e\\.spec\\.ts$',
  ],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/worker.ts',
    '!src/**/*.d.ts',
    '!src/**/*.routes.ts',
    '!src/shared/config/**',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 84,
      functions: 86,
      lines: 90,
    },
  },
  verbose: true,
};

export default config;