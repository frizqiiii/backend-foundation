/**
 * `env.ts` memvalidasi `process.env` secara EAGER saat di-import
 * (fail-fast) — supaya bisa menguji berbagai kombinasi
 * `NODE_ENV`/`JWT_SECRET`, module harus di-`require` ULANG dengan
 * `jest.resetModules()` setiap kali skenario env berubah, BUKAN
 * di-`import` statis biasa di puncak file (yang hanya akan
 * mengevaluasi env.ts SEKALI, dengan env dari `jest.setup.ts`).
 *
 * `process.env.NODE_ENV`/`JWT_SECRET` di-backup & DIKEMBALIKAN di
 * `afterEach` TANPA GAGAL — worker Jest bisa menjalankan banyak file
 * test lain secara berurutan di proses Node yang sama; kalau env ini
 * tidak dikembalikan, test file LAIN yang mengimpor `env.ts` bisa
 * ikut terpengaruh nilai yang ditinggalkan di sini.
 */
describe('env.ts — validasi kekuatan JWT_SECRET', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwtSecret = process.env.JWT_SECRET;
  let exitSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JWT_SECRET = originalJwtSecret;
    jest.resetModules();
    exitSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('production + secret lemah -> mencetak FATAL dan memanggil process.exit(1)', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'secret';

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- require dinamis diperlukan agar env.ts dievaluasi ulang
    require('./env');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('FATAL'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('production + secret kuat -> TIDAK memanggil process.exit maupun mencetak apa pun', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'x'.repeat(48);

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./env');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('development + secret lemah -> hanya PERINGATAN, proses TETAP jalan', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'changeme';

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./env');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PERINGATAN'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('test + secret lemah -> TIDAK ada peringatan sama sekali (noise di setiap file test)', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret-key';

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./env');

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
