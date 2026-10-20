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
    // Temuan T15 — erasure di bawah RLS, juga butuh database SUNGGUHAN (`npm run test:rls`).
    'privacy-erasure-rls\\.e2e\\.spec\\.ts$',
    // R16 — EventRepository di bawah RLS, juga butuh database SUNGGUHAN (`npm run test:rls`).
    'event-rls\\.e2e\\.spec\\.ts$',
    // R17 — ApiKeyRepository di bawah RLS, juga butuh database SUNGGUHAN (`npm run test:rls`).
    'api-key-rls\\.e2e\\.spec\\.ts$',
    // R19 — ExportRepository di bawah RLS, juga butuh database SUNGGUHAN (`npm run test:rls`).
    'export-rls\\.e2e\\.spec\\.ts$',
    // R15 — ProductRepository.findMany di bawah RLS, juga butuh database SUNGGUHAN (`npm run test:rls`).
    'product-rls\\.e2e\\.spec\\.ts$',
    // R18 — WebhookRepository di bawah RLS, juga butuh database SUNGGUHAN (`npm run test:rls`).
    'webhook-rls\\.e2e\\.spec\\.ts$',
    // R21 — DashboardRepository di bawah RLS, juga butuh database SUNGGUHAN (`npm run test:rls`).
    'dashboard-rls\\.e2e\\.spec\\.ts$',
  ],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/worker.ts',
    '!src/**/*.d.ts',
    // File spec adalah TES, bukan kode produksi. Spec yang dikecualikan dari run normal lewat
    // `testPathIgnorePatterns` (e2e RLS yang butuh DB sungguhan, contract spec) tidak dijalankan di
    // sini, sehingga Jest menghitungnya sebagai kode sumber ber-cakupan 0% dan menurunkan metrik global.
    '!src/**/*.spec.ts',
    '!src/**/*.routes.ts',
    '!src/shared/config/**',
  ],
  coverageDirectory: 'coverage',
  // Batas = angka nyata (`npm run test:coverage`, 20 Okt 2026: statements 97.89, branches 90.42, functions 97.31,
  // lines 98.16) dikurangi 1-2 poin. Cukup dekat supaya tes yang hilang terdeteksi CI, cukup longgar supaya satu
  // perubahan kecil tidak membuat CI merah secara acak. Naikkan lagi hanya kalau angka nyata naik dan stabil.
  coverageThreshold: {
    global: {
      statements: 96,
      branches: 88,
      functions: 95,
      lines: 96,
    },
  },
  verbose: true,
};

export default config;
