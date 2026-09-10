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
  // Phase 21 (Enterprise Quality) — test contract (`*.contract.spec.ts`,
  // lihat `src/modules/auth/auth.provider.contract.spec.ts`) BUKAN
  // unit test biasa: butuh SERVER SUNGGUHAN menyala + koneksi
  // database sungguhan (Pact Verifier membuat request HTTP nyata),
  // beda total dari seluruh test lain di sini yang memakai mock
  // Prisma/Redis. Dikecualikan dari `npm test`/`npm run test:coverage`
  // biasa — dijalankan TERPISAH lewat `npm run test:contract`
  // (`jest.contract.config.ts`, config khusus tanpa exclusion ini).
  testPathIgnorePatterns: ['/node_modules/', '\\.contract\\.spec\\.ts$'],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  clearMocks: true, // reset mock.calls & mock.results otomatis sebelum tiap test
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/**/*.d.ts',
    '!src/**/*.routes.ts',
    '!src/shared/config/**',
  ],
  coverageDirectory: 'coverage',
  // Phase 4 target: minimal 80% coverage. PENTING — angka ini hanya
  // akurat kalau `npx prisma generate` sudah dijalankan lebih dulu
  // (lihat catatan di README/Phase 4 report): tanpa Prisma Client
  // yang valid, SELURUH file `*.repository.ts` gagal dikompilasi sama
  // sekali untuk coverage collection (dianggap 0%, bukan "tidak
  // dihitung"), membuat angka total jatuh jauh di bawah kondisi
  // sebenarnya — bukan karena kurang test, tapi karena repository-nya
  // tidak pernah berhasil di-load coverage instrumentation-nya.
  // Phase 21 (Enterprise Quality) — dinaikkan dari 80% ke 90%
  // (statements/functions/lines) sesuai target Enterprise Quality.
  // `branches` SENGAJA tetap di bawah tiga lainnya (85%, bukan 90%)
  // — konsisten dengan gap yang SUDAH ADA di angka lama (70% vs 80%):
  // banyak percabangan defensif (`if (!x) throw new Error('tidak
  // mungkin terjadi')`, fallback error handling di jalur yang jarang
  // gagal) secara realistis TIDAK bernilai memaksa 100% dieksekusi di
  // unit test — memaksakannya mendorong penulisan test yang cuma
  // mengejar angka coverage, bukan menguji perilaku yang berarti.
  //
  // PENTING — SAMA seperti catatan di atas: angka ini hanya akurat
  // kalau `npx prisma generate` sudah dijalankan lebih dulu.
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 85,
      functions: 90,
      lines: 90,
    },
  },
  verbose: true,
};

export default config;
