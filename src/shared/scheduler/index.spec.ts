describe('startScheduler', () => {
  const cronValidate = jest.fn();
  const cronSchedule = jest.fn();
  const runJobWithRetry = jest.fn();
  const loggerError = jest.fn();
  const loggerInfo = jest.fn();

  async function loadModule() {
    let mod: typeof import('./index') | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('node-cron', () => ({
        validate: cronValidate,
        schedule: cronSchedule,
      }));
      jest.doMock('./job-runner', () => ({ runJobWithRetry }));
      jest.doMock('../logger', () => ({ logger: { error: loggerError, info: loggerInfo } }));
      // Job asli mengimpor `../../config/database` (PrismaClient
      // singleton) — di-mock murni supaya bisa di-require tanpa
      // mengonstruksi PrismaClient sungguhan (lihat catatan yang sama
      // di token-blacklist.spec.ts). Isi job itu sendiri sudah diuji
      // terpisah di masing-masing `*.job.spec.ts`.
      jest.doMock('../config/database', () => ({ prisma: {} }));
      mod = require('./index');
    });
    return mod!;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mendaftarkan cron.schedule untuk SETIAP job dengan cron expression valid, dengan timezone UTC', async () => {
    cronValidate.mockReturnValue(true);
    const { startScheduler } = await loadModule();

    startScheduler();

    // 6 job terdaftar: cleanup-refresh-tokens, cleanup-blacklisted-tokens,
    // cleanup-auth-tokens, database-maintenance, verify-audit-chain-integrity,
    // enforce-data-retention.
    expect(cronSchedule).toHaveBeenCalledTimes(6);
    for (const call of cronSchedule.mock.calls) {
      expect(call[2]).toEqual({ timezone: 'UTC' });
    }
  });

  it('P5 — job dengan cron expression TIDAK VALID dilewati (tidak didaftarkan ke cron.schedule), dicatat sebagai error', async () => {
    cronValidate.mockReturnValueOnce(false).mockReturnValue(true);
    const { startScheduler } = await loadModule();

    startScheduler();

    expect(cronSchedule).toHaveBeenCalledTimes(5);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ cronExpression: expect.any(String) }),
      expect.stringContaining('tidak valid')
    );
  });

  it('mencatat log info jumlah total job aktif setelah loop selesai', async () => {
    cronValidate.mockReturnValue(true);
    const { startScheduler } = await loadModule();

    startScheduler();

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('6 job aktif'));
  });

  it('P5 — callback yang diteruskan ke cron.schedule benar-benar memanggil runJobWithRetry(job) saat dieksekusi', async () => {
    cronValidate.mockReturnValue(true);
    const { startScheduler } = await loadModule();

    startScheduler();

    const [, scheduledCallback] = cronSchedule.mock.calls[0];
    scheduledCallback();

    expect(runJobWithRetry).toHaveBeenCalledTimes(1);
    expect(runJobWithRetry.mock.calls[0][0]).toHaveProperty('name');
  });
});
