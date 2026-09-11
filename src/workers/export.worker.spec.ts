/**
 * Strategi test: SAMA pola dengan email/notification/webhook worker
 * spec (`jest.isolateModulesAsync` + `jest.doMock('bullmq')` untuk
 * menangkap processor + event handler tanpa konek Redis sungguhan).
 * BEDANYA: `export.worker.ts` juga membuat `new PrismaClient()` DAN
 * meng-instantiate rantai kelas konkret (`ExportRepository`,
 * `ExportService`, `UserRepository`, `AuditRepository`,
 * `DashboardRepository`/`DashboardService`,
 * `AnalyticsRepository`/`AnalyticsService`, `ReportingService`) di
 * module scope — SEMUA itu harus di-mock juga, bukan cuma `bullmq`,
 * supaya modul ini bisa di-`require` ulang tanpa Prisma Client
 * sungguhan tersedia.
 */
import type { ExportJobData } from '../shared/queue/export.queue';

describe('export.worker', () => {
  const processExportJob = jest.fn();
  const moveToDeadLetter = jest.fn();
  const observeQueueProcessingTime = jest.fn((_queue: string, fn: () => Promise<unknown>) => fn());
  const loggerInfo = jest.fn();
  const loggerError = jest.fn();
  let capturedProcessor: ((job: { data: ExportJobData }) => Promise<void>) | undefined;
  let capturedHandlers: Record<string, (...args: unknown[]) => void>;

  async function loadWorkerModule() {
    let mod: typeof import('./export.worker') | undefined;
    await jest.isolateModulesAsync(async () => {
      capturedHandlers = {};
      jest.doMock('bullmq', () => ({
        Worker: jest
          .fn()
          .mockImplementation((_name: string, processor: typeof capturedProcessor) => {
            capturedProcessor = processor;
            return {
              on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
                capturedHandlers[event] = handler;
              }),
            };
          }),
      }));
      jest.doMock('@prisma/client', () => ({
        PrismaClient: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/exports/export.repository', () => ({
        ExportRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/exports/export.service', () => ({
        ExportService: jest.fn().mockImplementation(() => ({ processExportJob })),
      }));
      jest.doMock('../modules/users/user.repository', () => ({
        UserRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/audit/audit.repository', () => ({
        AuditRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/dashboard/dashboard.repository', () => ({
        DashboardRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/dashboard/dashboard.service', () => ({
        DashboardService: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/analytics/analytics.repository', () => ({
        AnalyticsRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/analytics/analytics.service', () => ({
        AnalyticsService: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/reporting/reporting.service', () => ({
        ReportingService: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../shared/queue/connection', () => ({ queueConnection: {} }));
      jest.doMock('../shared/queue/dead-letter.queue', () => ({ moveToDeadLetter }));
      jest.doMock('../shared/queue/queue.metrics', () => ({ observeQueueProcessingTime }));
      jest.doMock('../shared/logger', () => ({
        logger: { info: loggerInfo, error: loggerError },
      }));
      jest.doMock('../shared/observability/bullmq-telemetry', () => ({ bullMQTelemetry: null }));

      mod = require('./export.worker');
    });
    return mod!;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    capturedProcessor = undefined;
  });

  it('exportWorker bernilai null kalau queueConnection null (Redis tidak dikonfigurasi) — perilaku default lingkungan test biasa', async () => {
    // BEDA dari email/notification/webhook worker: export.worker.ts
    // meng-instantiate rantai kelas Prisma-touching (ExportRepository,
    // UserRepository, dst) SEBELUM baris `queueConnection ? new
    // Worker(...) : null` dievaluasi — jadi seluruh rantai itu tetap
    // harus di-mock supaya modul bisa di-require sama sekali, meski
    // yang sedang diuji di sini murni soal queueConnection null.
    // `bullmq` SENGAJA TIDAK di-mock di test ini supaya `new Worker`
    // yang sungguhan tidak pernah tereksekusi (short-circuit oleh
    // `queueConnection ? ... : null`), membuktikan constructor asli
    // memang tidak dipanggil saat Redis tidak dikonfigurasi.
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@prisma/client', () => ({
        PrismaClient: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/exports/export.repository', () => ({
        ExportRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/exports/export.service', () => ({
        ExportService: jest.fn().mockImplementation(() => ({ processExportJob })),
      }));
      jest.doMock('../modules/users/user.repository', () => ({
        UserRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/audit/audit.repository', () => ({
        AuditRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/dashboard/dashboard.repository', () => ({
        DashboardRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/dashboard/dashboard.service', () => ({
        DashboardService: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/analytics/analytics.repository', () => ({
        AnalyticsRepository: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/analytics/analytics.service', () => ({
        AnalyticsService: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../modules/reporting/reporting.service', () => ({
        ReportingService: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('../shared/queue/connection', () => ({ queueConnection: null }));

      const realMod: typeof import('./export.worker') = require('./export.worker');
      expect(realMod.exportWorker).toBeNull();
    });
  });

  it('processor memanggil exportService.processExportJob(job.data) dibungkus observeQueueProcessingTime("export", ...)', async () => {
    await loadWorkerModule();
    processExportJob.mockResolvedValue(undefined);
    const jobData: ExportJobData = {
      exportJobId: 'exp-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    } as ExportJobData;

    await capturedProcessor!({ data: jobData });

    expect(observeQueueProcessingTime).toHaveBeenCalledWith('export', expect.any(Function));
    expect(processExportJob).toHaveBeenCalledWith(jobData);
  });

  it('P5 — event "failed": job SUDAH kehabisan seluruh percobaan (attemptsMade >= attempts) -> dipindah ke dead-letter queue', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-1',
      name: 'export',
      data: { exportJobId: 'exp-1', tenantId: 'tenant-1', userId: 'user-1' },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };
    const err = new Error('Object storage timeout');

    capturedHandlers.failed(job, err);
    await new Promise(process.nextTick);

    expect(loggerError).toHaveBeenCalled();
    expect(moveToDeadLetter).toHaveBeenCalledWith({
      queue: 'export',
      jobName: 'export',
      data: job.data,
      failedReason: 'Object storage timeout',
      attemptsMade: 3,
    });
  });

  it('P5 — event "failed": job MASIH ada sisa percobaan retry -> TIDAK dipindah ke dead-letter queue (BullMQ akan retry otomatis)', async () => {
    await loadWorkerModule();
    const job = {
      id: 'job-2',
      name: 'export',
      data: { exportJobId: 'exp-2', tenantId: 'tenant-1', userId: 'user-1' },
      attemptsMade: 1,
      opts: { attempts: 3 },
    };

    capturedHandlers.failed(job, new Error('sementara gagal'));
    await new Promise(process.nextTick);

    expect(moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('P5 — event "failed": job undefined (edge case BullMQ) ditangani tanpa melempar, TIDAK memindah ke dead-letter', async () => {
    await loadWorkerModule();

    expect(() => capturedHandlers.failed(undefined, new Error('unknown'))).not.toThrow();
    expect(moveToDeadLetter).not.toHaveBeenCalled();
  });

  it('event "completed" mencatat log info dengan id job dan exportJobId', async () => {
    await loadWorkerModule();
    const job = { id: 'job-3', data: { exportJobId: 'exp-3' } };

    capturedHandlers.completed(job);

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('job-3'));
  });
});
