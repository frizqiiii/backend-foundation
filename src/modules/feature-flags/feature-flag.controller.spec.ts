import type { Request, Response } from 'express';
import { FeatureFlagController } from './feature-flag.controller';
import type { FeatureFlagService } from './feature-flag.service';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('FeatureFlagController', () => {
  let featureFlagService: jest.Mocked<FeatureFlagService>;
  let controller: FeatureFlagController;

  beforeEach(() => {
    featureFlagService = {
      listAll: jest.fn(),
      upsert: jest.fn(),
    } as unknown as jest.Mocked<FeatureFlagService>;
    controller = new FeatureFlagController(featureFlagService);
  });

  describe('list', () => {
    it('membalas daftar seluruh flag dari service', async () => {
      const req = {} as Request;
      const res = createMockResponse();
      const flags = [{ key: 'new-checkout', enabled: true }];
      featureFlagService.listAll.mockResolvedValue(flags as never);

      await controller.list(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: flags }));
    });
  });

  describe('upsert', () => {
    it('meneruskan key dari path param dan body yang sudah divalidasi ke service', async () => {
      const req = {
        params: { key: 'new-checkout' },
        body: { enabled: true, description: 'Alur checkout baru' },
      } as unknown as Request;
      const res = createMockResponse();
      const flag = { key: 'new-checkout', enabled: true };
      featureFlagService.upsert.mockResolvedValue(flag as never);

      await controller.upsert(req, res);

      expect(featureFlagService.upsert).toHaveBeenCalledWith('new-checkout', {
        enabled: true,
        description: 'Alur checkout baru',
      });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: flag }));
    });

    it('P5 — menolak body tanpa field enabled (wajib)', async () => {
      const req = { params: { key: 'new-checkout' }, body: {} } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.upsert(req, res)).rejects.toThrow();
      expect(featureFlagService.upsert).not.toHaveBeenCalled();
    });
  });
});
