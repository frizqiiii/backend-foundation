import type { Request, Response } from 'express';
import { UploadController } from './upload.controller';
import type { UploadService } from './upload.service';
import type { ActivityService } from '../activity/activity.service';
import { BadRequestError, UnauthorizedError } from '../../shared/utils/http-error';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createMockRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    ip: '10.0.0.1',
    get: jest.fn().mockReturnValue('curl/8.0'),
    params: {},
    ...overrides,
  } as unknown as Request;
}

describe('UploadController', () => {
  let uploadService: jest.Mocked<UploadService>;
  let activityService: jest.Mocked<ActivityService>;
  let controller: UploadController;

  beforeEach(() => {
    uploadService = {
      uploadFile: jest.fn(),
      getFile: jest.fn(),
      deleteFile: jest.fn(),
    } as unknown as jest.Mocked<UploadService>;
    activityService = { logFileUpload: jest.fn() } as unknown as jest.Mocked<ActivityService>;
    controller = new UploadController(uploadService, activityService);
  });

  describe('uploadSingle', () => {
    it('mengupload file, mencatat aktivitas dengan metadata file, membalas 201', async () => {
      const req = createMockRequest({
        user: { id: 'user-1' },
        file: {
          buffer: Buffer.from('data'),
          mimetype: 'image/png',
          originalname: 'foto.png',
          size: 1024,
        },
      });
      const res = createMockResponse();
      const uploaded = { id: 'file-1', url: 'https://cdn/file-1', key: 'file-1' };
      uploadService.uploadFile.mockResolvedValue(uploaded as never);

      await controller.uploadSingle(req, res);

      expect(uploadService.uploadFile).toHaveBeenCalledWith(
        { buffer: Buffer.from('data'), mimetype: 'image/png', originalname: 'foto.png' },
        'user-1'
      );
      expect(activityService.logFileUpload).toHaveBeenCalledWith(
        expect.stringContaining('foto.png'),
        expect.objectContaining({ userId: 'user-1' }),
        { originalname: 'foto.png', mimetype: 'image/png', sizeBytes: 1024 }
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: uploaded }));
    });

    it('P5 — melempar BadRequestError kalau tidak ada req.file sama sekali', async () => {
      const req = createMockRequest({ user: { id: 'user-1' } });
      const res = createMockResponse();

      await expect(controller.uploadSingle(req, res)).rejects.toThrow(BadRequestError);
      expect(uploadService.uploadFile).not.toHaveBeenCalled();
    });

    it('P5 — melempar UnauthorizedError (safety-net) kalau req.user tidak ada meski req.file ada', async () => {
      const req = createMockRequest({
        file: { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'x.png', size: 1 },
      });
      const res = createMockResponse();

      await expect(controller.uploadSingle(req, res)).rejects.toThrow(UnauthorizedError);
      expect(uploadService.uploadFile).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('meneruskan req.user penuh ke service (otorisasi kepemilikan di Service)', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', role: 'USER' },
        params: { id: 'file-1' },
      });
      const res = createMockResponse();
      const file = { id: 'file-1', url: 'https://cdn/file-1' };
      uploadService.getFile.mockResolvedValue(file as never);

      await controller.getById(req, res);

      expect(uploadService.getFile).toHaveBeenCalledWith('file-1', { id: 'user-1', role: 'USER' });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: file }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ params: { id: 'file-1' } });
      const res = createMockResponse();

      await expect(controller.getById(req, res)).rejects.toThrow(UnauthorizedError);
      expect(uploadService.getFile).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('menghapus file, mencatat aktivitas dengan fileId, membalas 200 data null', async () => {
      const req = createMockRequest({
        user: { id: 'user-1', role: 'USER' },
        params: { id: 'file-1' },
      });
      const res = createMockResponse();

      await controller.remove(req, res);

      expect(uploadService.deleteFile).toHaveBeenCalledWith('file-1', {
        id: 'user-1',
        role: 'USER',
      });
      expect(activityService.logFileUpload).toHaveBeenCalledWith(
        expect.stringContaining('file-1'),
        expect.objectContaining({ userId: 'user-1' }),
        { fileId: 'file-1' }
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
    });

    it('P5 — melempar UnauthorizedError kalau req.user tidak ada', async () => {
      const req = createMockRequest({ params: { id: 'file-1' } });
      const res = createMockResponse();

      await expect(controller.remove(req, res)).rejects.toThrow(UnauthorizedError);
      expect(uploadService.deleteFile).not.toHaveBeenCalled();
    });
  });
});
