import { ExportService } from './export.service';
import type { ExportRepository, ExportJob } from './export.repository';
import type { UserRepository } from '../users/user.repository';
import type { AuditRepository } from '../audit/audit.repository';
import type { DashboardService } from '../dashboard/dashboard.service';
import type { ReportingService } from '../reporting/reporting.service';
import type { AnalyticsService } from '../analytics/analytics.service';
import { NotFoundError } from '../../shared/utils/http-error';

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

      expect(exportRepository.markProcessing).toHaveBeenCalledWith('exp-1');
      expect(exportRepository.markCompleted).toHaveBeenCalledWith(
        'exp-1',
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

      expect(exportRepository.markProcessing).toHaveBeenCalledWith('exp-1');
      expect(mockStorage.upload).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'text/csv' })
      );
      const uploadedBody = mockStorage.upload.mock.calls[0][0].body as Buffer;
      expect(uploadedBody.toString('utf-8')).toContain('budi@example.com');
      expect(exportRepository.markCompleted).toHaveBeenCalledWith(
        'exp-1',
        'https://storage.example.com/exports/file.csv'
      );
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

      expect(exportRepository.markFailed).toHaveBeenCalledWith('exp-1', 'S3 down');
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
        expect.stringContaining('reportingService belum di-wire')
      );
    });
  });
});
