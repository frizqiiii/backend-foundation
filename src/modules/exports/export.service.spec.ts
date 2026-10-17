import { ExportService } from './export.service';
import type { ExportRepository, ExportJob } from './export.repository';
import type { UserRepository } from '../users/user.repository';
import type { AuditRepository } from '../audit/audit.repository';
import type { DashboardService } from '../dashboard/dashboard.service';
import type { ReportingService } from '../reporting/reporting.service';
import type { AnalyticsService } from '../analytics/analytics.service';
import { ForbiddenError, NotFoundError } from '../../shared/utils/http-error';
import { getTenantContext, runWithTenantContext } from '../../shared/tenant/tenant-context';

jest.mock('../../shared/queue/export.queue', () => ({
  // `add` di-mock di sini, TIDAK di `beforeEach` biasa — supaya bisa
  // dites baik kondisi "queue tersedia" (add dipanggil) MAUPUN
  // "queue null" (fallback sinkron) lewat `mockExportQueue` di bawah
  // yang di-reset per-test.
  exportQueue: { add: jest.fn() },
}));

jest.mock('../../shared/integrations/storage', () => ({
  objectStorageProvider: { upload: jest.fn() },
}));

jest.mock('../../shared/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { exportQueue: mockExportQueue } = jest.requireMock('../../shared/queue/export.queue');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { objectStorageProvider: mockStorage } = jest.requireMock(
  '../../shared/integrations/storage'
);

describe('ExportService', () => {
  let exportRepository: jest.Mocked<ExportRepository>;
  let userRepository: jest.Mocked<UserRepository>;
  let auditRepository: jest.Mocked<AuditRepository>;
  let dashboardService: jest.Mocked<DashboardService>;
  let reportingService: jest.Mocked<ReportingService>;
  let analyticsService: jest.Mocked<AnalyticsService>;
  let service: ExportService;

  const baseExportJob: ExportJob = {
    id: 'exp-1',
    userId: 'user-1',
    tenantId: null,
    type: 'USERS',
    format: 'CSV',
    status: 'QUEUED',
    fileUrl: null,
    errorMessage: null,
    createdAt: new Date(),
    completedAt: null,
  } as ExportJob;

  beforeEach(() => {
    jest.clearAllMocks();
    exportRepository = {
      create: jest.fn().mockResolvedValue(baseExportJob),
      findById: jest.fn(),
      findByIdForUser: jest.fn(),
      markProcessing: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
      // R22 — default: lewati begitu saja (tanpa konteks tenant). Tes R22 di bawah menggantinya dengan versi yang
      // memasang konteks tenant seperti repository sungguhan.
      runInTenantScope: jest
        .fn()
        .mockImplementation((_tenantId: string | null, fn: () => Promise<unknown>) => fn()),
    } as unknown as jest.Mocked<ExportRepository>;

    userRepository = {
      findMany: jest.fn().mockResolvedValue({
        data: [
          {
            id: 'u1',
            name: 'Budi',
            email: 'budi@example.com',
            role: 'USER',
            createdAt: new Date('2026-01-01'),
          },
        ],
        total: 1,
      }),
    } as unknown as jest.Mocked<UserRepository>;

    auditRepository = {
      findRecent: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<AuditRepository>;

    dashboardService = {
      getStats: jest.fn().mockResolvedValue({
        totals: { users: 1, events: 0, products: 0, uploads: 0 },
        usersByRole: { USER: 1 },
        eventsByCategory: {},
        signupsLast30Days: [{ date: '2026-08-01', count: 1 }],
      }),
    } as unknown as jest.Mocked<DashboardService>;

    reportingService = {
      getUserStatistics: jest.fn().mockResolvedValue({
        total: 1,
        byRole: { USER: 1 },
        signupsLast30Days: [{ date: '2026-08-01', count: 1 }],
      }),
      getEventStatistics: jest.fn().mockResolvedValue({
        total: 2,
        byCategory: { seminar: 2 },
        upcoming: 1,
        past: 1,
      }),
      getProductStatistics: jest.fn().mockResolvedValue({
        total: 3,
        byStatus: { ACTIVE: 3 },
        byCategory: { STANDARD: 3 },
      }),
      getSystemStatistics: jest.fn().mockResolvedValue({
        totalUploads: 4,
        auditLogByAction: { LOGIN: 4 },
        dailyActiveUsersLast30Days: [{ date: '2026-08-01', count: 2 }],
      }),
    } as unknown as jest.Mocked<ReportingService>;

    analyticsService = {
      getDailyActiveUsers: jest.fn().mockResolvedValue({
        days: 90,
        data: [{ date: '2026-08-01', count: 2 }],
      }),
    } as unknown as jest.Mocked<AnalyticsService>;

    service = new ExportService(
      exportRepository,
      userRepository,
      auditRepository,
      dashboardService,
      reportingService,
      analyticsService
    );

    mockStorage.upload.mockResolvedValue({ url: 'https://storage.example.com/exports/file.csv' });
  });

  describe('requestExport', () => {
    it('mengirim job ke exportQueue.add ketika queue tersedia — TIDAK memproses sinkron', async () => {
      const result = await service.requestExport({
        userId: 'user-1',
        tenantId: null,
        type: 'USERS',
        format: 'CSV',
      });

      expect(result).toEqual(baseExportJob);
      expect(mockExportQueue.add).toHaveBeenCalledWith(
        'export',
        expect.objectContaining({ exportJobId: 'exp-1', type: 'USERS', format: 'CSV' })
      );
      expect(exportRepository.markProcessing).not.toHaveBeenCalled();
    });

    it('fallback ke processExportJob sinkron ketika exportQueue null', async () => {
      mockExportQueue.add = null as unknown as jest.Mock;
      // Simulasikan `exportQueue` bernilai `null` — modul di-mock
      // ulang sesaat untuk kasus ini saja.
      jest.resetModules();
      jest.doMock('../../shared/queue/export.queue', () => ({ exportQueue: null }));
      jest.doMock('../../shared/integrations/storage', () => ({
        objectStorageProvider: mockStorage,
      }));
      jest.doMock('../../shared/logger', () => ({
        logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
      }));

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ExportService: IsolatedExportService } = require('./export.service');
      const isolatedService = new IsolatedExportService(
        exportRepository,
        userRepository,
        auditRepository,
        dashboardService
      );

      await isolatedService.requestExport({
        userId: 'user-1',
        tenantId: null,
        type: 'USERS',
        format: 'CSV',
      });

      expect(exportRepository.markProcessing).toHaveBeenCalledWith('exp-1', null);
      expect(exportRepository.markCompleted).toHaveBeenCalledWith(
        'exp-1',
        null,
        'https://storage.example.com/exports/file.csv'
      );
    });
  });

  describe('getExportStatus', () => {
    it('melempar NotFoundError kalau export tidak ditemukan/bukan milik user', async () => {
      exportRepository.findByIdForUser.mockResolvedValue(null);
      await expect(service.getExportStatus('exp-x', 'user-1')).rejects.toThrow(NotFoundError);
    });

    it('mengembalikan export job kalau ditemukan', async () => {
      exportRepository.findByIdForUser.mockResolvedValue(baseExportJob);
      const result = await service.getExportStatus('exp-1', 'user-1');
      expect(result).toEqual(baseExportJob);
    });
  });

  describe('processExportJob', () => {
    it('generate CSV untuk tipe USERS, upload ke storage, dan markCompleted dengan URL-nya', async () => {
      await service.processExportJob({
        exportJobId: 'exp-1',
        type: 'USERS',
        format: 'CSV',
        userId: 'user-1',
        tenantId: null,
      });

      expect(exportRepository.markProcessing).toHaveBeenCalledWith('exp-1', null);
      expect(mockStorage.upload).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'text/csv' })
      );
      const uploadedBody = mockStorage.upload.mock.calls[0][0].body as Buffer;
      expect(uploadedBody.toString('utf-8')).toContain('budi@example.com');
      expect(exportRepository.markCompleted).toHaveBeenCalledWith(
        'exp-1',
        null,
        'https://storage.example.com/exports/file.csv'
      );
    });

    it('R19: tenantId dari data job diteruskan ke markProcessing, markCompleted, dan markFailed (worker tanpa konteks tenant)', async () => {
      const job = {
        exportJobId: 'exp-1',
        type: 'USERS' as const,
        format: 'CSV' as const,
        userId: 'user-1',
        tenantId: 'tenant-1',
      };

      await service.processExportJob(job);
      expect(exportRepository.markProcessing).toHaveBeenCalledWith('exp-1', 'tenant-1');
      expect(exportRepository.markCompleted).toHaveBeenCalledWith(
        'exp-1',
        'tenant-1',
        'https://storage.example.com/exports/file.csv'
      );

      mockStorage.upload.mockRejectedValueOnce(new Error('S3 down'));
      await expect(service.processExportJob(job)).rejects.toThrow('S3 down');
      expect(exportRepository.markFailed).toHaveBeenCalledWith('exp-1', 'tenant-1', 'S3 down');
    });

    it('markFailed dan melempar ulang error kalau storage upload gagal', async () => {
      mockStorage.upload.mockRejectedValue(new Error('S3 down'));

      await expect(
        service.processExportJob({
          exportJobId: 'exp-1',
          type: 'USERS',
          format: 'CSV',
          userId: 'user-1',
          tenantId: null,
        })
      ).rejects.toThrow('S3 down');

      expect(exportRepository.markFailed).toHaveBeenCalledWith('exp-1', null, 'S3 down');
    });

    it('generate XLSX untuk tipe DASHBOARD_STATS, meratakan signupsLast30Days jadi baris per hari', async () => {
      await service.processExportJob({
        exportJobId: 'exp-1',
        type: 'DASHBOARD_STATS',
        format: 'XLSX',
        userId: 'user-1',
        tenantId: null,
      });

      expect(dashboardService.getStats).toHaveBeenCalled();
      expect(mockStorage.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      );
    });

    it('generate PDF untuk tipe AUDIT_LOG', async () => {
      auditRepository.findRecent.mockResolvedValue([
        {
          id: 'a1',
          userId: 'user-1',
          action: 'LOGIN',
          entity: 'User',
          entityId: 'user-1',
          ipAddress: '127.0.0.1',
          userAgent: 'jest',
          createdAt: new Date(),
        },
      ] as never);

      await service.processExportJob({
        exportJobId: 'exp-1',
        type: 'AUDIT_LOG',
        format: 'PDF',
        userId: 'user-1',
        tenantId: null,
      });

      expect(auditRepository.findRecent).toHaveBeenCalled();
      expect(mockStorage.upload).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'application/pdf' })
      );
    });

    it.each([
      ['USER_STATISTICS', 'getUserStatistics'],
      ['EVENT_STATISTICS', 'getEventStatistics'],
      ['PRODUCT_STATISTICS', 'getProductStatistics'],
      ['SYSTEM_STATISTICS', 'getSystemStatistics'],
    ] as const)('generate CSV untuk tipe %s lewat ReportingService.%s', async (type, method) => {
      await service.processExportJob({
        exportJobId: 'exp-1',
        type,
        format: 'CSV',
        userId: 'user-1',
        tenantId: null,
      });

      expect(reportingService[method]).toHaveBeenCalled();
      expect(mockStorage.upload).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'text/csv' })
      );
    });

    it('generate XLSX untuk tipe DAILY_ACTIVE_USERS lewat AnalyticsService.getDailyActiveUsers(90)', async () => {
      await service.processExportJob({
        exportJobId: 'exp-1',
        type: 'DAILY_ACTIVE_USERS',
        format: 'XLSX',
        userId: 'user-1',
        tenantId: null,
      });

      expect(analyticsService.getDailyActiveUsers).toHaveBeenCalledWith(90);
      expect(mockStorage.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      );
    });

    it('menandai export FAILED dengan pesan jelas kalau reportingService belum di-wire', async () => {
      const serviceWithoutReporting = new ExportService(
        exportRepository,
        userRepository,
        auditRepository,
        dashboardService
      );

      await expect(
        serviceWithoutReporting.processExportJob({
          exportJobId: 'exp-1',
          type: 'USER_STATISTICS',
          format: 'CSV',
          userId: 'user-1',
          tenantId: null,
        })
      ).rejects.toThrow('reportingService belum di-wire');

      expect(exportRepository.markFailed).toHaveBeenCalledWith(
        'exp-1',
        null,
        expect.stringContaining('reportingService belum di-wire')
      );
    });
  });
  // R22 — worker BullMQ tidak punya konteks tenant. Tanpa scope, `userRepository.findMany` tidak memfilter tenant
  // (file export admin tenant A memuat user SEMUA tenant) dan repository statistik jatuh ke mode PLATFORM (angka global
  // lewat bypass RLS). Perbaikannya: dataset dibangun DI DALAM scope tenant milik job.
  describe('R22 — scope tenant jalur worker', () => {
    // Meniru `ExportRepository.runInTenantScope` sungguhan: memasang konteks tenant selama `fn`.
    function useRealisticTenantScope() {
      exportRepository.runInTenantScope.mockImplementation(
        (tenantId: string | null, fn: () => Promise<unknown>) =>
          runWithTenantContext({ tenantId, tenantSlug: null, db: null }, fn) as never
      );
    }

    const jobOf = (type: 'USERS' | 'DASHBOARD_STATS' | 'USER_STATISTICS', tenantId: string) => ({
      exportJobId: 'exp-1',
      type,
      format: 'CSV' as const,
      userId: 'user-1',
      tenantId,
    });

    it('dataset USERS dibangun di dalam scope tenant job (findMany melihat tenantId job)', async () => {
      useRealisticTenantScope();
      let tenantSeenByQuery: string | null | undefined;
      userRepository.findMany.mockImplementation(async () => {
        tenantSeenByQuery = getTenantContext().tenantId;
        return { data: [], total: 0 };
      });

      await service.processExportJob(jobOf('USERS', 'tenant-A'));

      expect(exportRepository.runInTenantScope).toHaveBeenCalledWith(
        'tenant-A',
        expect.any(Function)
      );
      expect(tenantSeenByQuery).toBe('tenant-A');
    });

    it.each([['DASHBOARD_STATS'], ['USER_STATISTICS']] as const)(
      'dataset %s juga dibangun di dalam scope tenant job',
      async (type) => {
        useRealisticTenantScope();
        let tenantSeen: string | null | undefined;
        dashboardService.getStats.mockImplementation(async () => {
          tenantSeen = getTenantContext().tenantId;
          return {
            totals: { users: 1, events: 0, products: 0, uploads: null },
            usersByRole: {},
            eventsByCategory: {},
            signupsLast30Days: [],
          } as never;
        });
        reportingService.getUserStatistics.mockImplementation(async () => {
          tenantSeen = getTenantContext().tenantId;
          return { total: 0, byRole: {}, signupsLast30Days: [] } as never;
        });

        await service.processExportJob(jobOf(type, 'tenant-A'));

        expect(tenantSeen).toBe('tenant-A');
      }
    );

    it('render file dan upload ke storage terjadi DI LUAR scope tenant (tidak menahan transaksi DB selama upload)', async () => {
      useRealisticTenantScope();
      let tenantSeenDuringUpload: string | null | undefined = 'belum-dicek';
      mockStorage.upload.mockImplementation(async () => {
        tenantSeenDuringUpload = getTenantContext().tenantId;
        return { url: 'https://storage.example.com/exports/file.csv' };
      });

      await service.processExportJob(jobOf('USERS', 'tenant-A'));

      expect(tenantSeenDuringUpload).toBeNull();
    });

    it('kegagalan di dalam scope tetap menandai FAILED dan melempar ulang (retry BullMQ)', async () => {
      useRealisticTenantScope();
      userRepository.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.processExportJob(jobOf('USERS', 'tenant-A'))).rejects.toThrow('db down');

      expect(exportRepository.markFailed).toHaveBeenCalledWith('exp-1', 'tenant-A', 'db down');
      expect(mockStorage.upload).not.toHaveBeenCalled();
    });
  });

  // R22 — tipe yang sumbernya tidak punya kolom tenant (audit_logs, file_uploads) tidak bisa dipisah per tenant.
  describe('R22 — requestExport menolak tipe yang tidak bisa dipisah per tenant', () => {
    beforeEach(() => {
      // Tes lama di atas mengosongkan `mockExportQueue.add` (simulasi queue null) dan itu menular ke tes berikutnya.
      mockExportQueue.add = jest.fn().mockResolvedValue(undefined);
    });

    it.each([['AUDIT_LOG'], ['SYSTEM_STATISTICS'], ['DAILY_ACTIVE_USERS']] as const)(
      'tenant aktif + tipe %s ditolak 403 sebelum job dibuat atau di-enqueue',
      async (type) => {
        await expect(
          service.requestExport({ userId: 'user-1', tenantId: 'tenant-A', type, format: 'CSV' })
        ).rejects.toThrow(ForbiddenError);

        expect(exportRepository.create).not.toHaveBeenCalled();
        expect(mockExportQueue.add).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['USERS'],
      ['DASHBOARD_STATS'],
      ['USER_STATISTICS'],
      ['EVENT_STATISTICS'],
      ['PRODUCT_STATISTICS'],
    ] as const)('tenant aktif + tipe %s tetap diterima', async (type) => {
      await service.requestExport({ userId: 'user-1', tenantId: 'tenant-A', type, format: 'CSV' });

      expect(exportRepository.create).toHaveBeenCalledTimes(1);
      expect(mockExportQueue.add).toHaveBeenCalledTimes(1);
    });
  });
});
