import type { Request, Response } from 'express';
import { ExportController } from './export.controller';
import type { ExportService } from './export.service';
import { UnauthorizedError, ConflictError } from '../../shared/utils/http-error';
import { getTenantContext } from '../../shared/tenant/tenant-context';

jest.mock('../../shared/tenant/tenant-context', () => ({
  getTenantContext: jest.fn(),
}));

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}

const sampleJob = {
  id: 'export-1',
  type: 'USERS',
  format: 'CSV',
  status: 'QUEUED',
  fileUrl: null,
  errorMessage: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt: null,
};

describe('ExportController', () => {
  let exportService: jest.Mocked<ExportService>;
  let controller: ExportController;

  beforeEach(() => {
    jest.clearAllMocks();
    exportService = {
      requestExport: jest.fn(),
      getExportStatus: jest.fn(),
    } as unknown as jest.Mocked<ExportService>;
    controller = new ExportController(exportService);
    (getTenantContext as jest.Mock).mockReturnValue({ tenantId: 'tenant-1' });
  });

  describe('create', () => {
    it('meminta export dengan userId+tenantId dari konteks, membalas 202', async () => {
      const req = {
        user: { id: 'user-1' },
        body: { type: 'USERS', format: 'CSV' },
      } as unknown as Request;
      const res = createMockResponse();
      exportService.requestExport.mockResolvedValue(sampleJob as never);

      await controller.create(req, res);

      expect(exportService.requestExport).toHaveBeenCalledWith({
        userId: 'user-1',
        tenantId: 'tenant-1',
        type: 'USERS',
        format: 'CSV',
      });
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ id: 'export-1' }) })
      );
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = { body: { type: 'USERS', format: 'CSV' } } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow(UnauthorizedError);
      expect(exportService.requestExport).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('membalas status export milik req.user.id', async () => {
      const req = { user: { id: 'user-1' }, params: { id: 'export-1' } } as unknown as Request;
      const res = createMockResponse();
      exportService.getExportStatus.mockResolvedValue(sampleJob as never);

      await controller.getStatus(req, res);

      expect(exportService.getExportStatus).toHaveBeenCalledWith('export-1', 'user-1');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ id: 'export-1' }) })
      );
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = { params: { id: 'export-1' } } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.getStatus(req, res)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('download', () => {
    it('redirect 302 ke fileUrl kalau status COMPLETED', async () => {
      const req = { user: { id: 'user-1' }, params: { id: 'export-1' } } as unknown as Request;
      const res = createMockResponse();
      exportService.getExportStatus.mockResolvedValue({
        ...sampleJob,
        status: 'COMPLETED',
        fileUrl: 'https://storage/export-1.csv',
      } as never);

      await controller.download(req, res);

      expect(res.redirect).toHaveBeenCalledWith(302, 'https://storage/export-1.csv');
    });

    it('P5 — melempar ConflictError kalau status BELUM COMPLETED (mis. masih PROCESSING)', async () => {
      const req = { user: { id: 'user-1' }, params: { id: 'export-1' } } as unknown as Request;
      const res = createMockResponse();
      exportService.getExportStatus.mockResolvedValue({
        ...sampleJob,
        status: 'PROCESSING',
      } as never);

      await expect(controller.download(req, res)).rejects.toThrow(ConflictError);
      expect(res.redirect).not.toHaveBeenCalled();
    });

    it('P5 — melempar ConflictError kalau status COMPLETED tapi fileUrl null (state tak terduga, safety-net)', async () => {
      const req = { user: { id: 'user-1' }, params: { id: 'export-1' } } as unknown as Request;
      const res = createMockResponse();
      exportService.getExportStatus.mockResolvedValue({
        ...sampleJob,
        status: 'COMPLETED',
        fileUrl: null,
      } as never);

      await expect(controller.download(req, res)).rejects.toThrow(ConflictError);
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = { params: { id: 'export-1' } } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.download(req, res)).rejects.toThrow(UnauthorizedError);
      expect(exportService.getExportStatus).not.toHaveBeenCalled();
    });
  });
});
