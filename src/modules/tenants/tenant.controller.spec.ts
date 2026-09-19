import type { Request, Response } from 'express';
import { TenantController } from './tenant.controller';
import type { TenantService } from './tenant.service';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('TenantController', () => {
  let tenantService: jest.Mocked<TenantService>;
  let controller: TenantController;

  beforeEach(() => {
    tenantService = {
      list: jest.fn(),
      create: jest.fn(),
      updatePlan: jest.fn(),
    } as unknown as jest.Mocked<TenantService>;
    controller = new TenantController(tenantService);
  });

  describe('list', () => {
    it('P5 — mem-parsing query pagination dan membalas data+meta (dipaginasi sejak P3, bukan lagi unbounded)', async () => {
      const req = { query: { page: '2', limit: '10' } } as unknown as Request;
      const res = createMockResponse();
      const result = {
        data: [{ id: 'tenant-1' }],
        meta: { page: 2, limit: 10, total: 15, totalPages: 2 },
      };
      tenantService.list.mockResolvedValue(result as never);

      await controller.list(req, res);

      expect(tenantService.list).toHaveBeenCalledWith({ page: 2, limit: 10 });
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: result.data, meta: result.meta })
      );
    });
  });

  describe('create', () => {
    it('membuat tenant dari body, membalas 201', async () => {
      const req = { body: { slug: 'acme-corp', name: 'Acme Corp' } } as unknown as Request;
      const res = createMockResponse();
      const tenant = { id: 'tenant-1', slug: 'acme-corp', name: 'Acme Corp' };
      tenantService.create.mockResolvedValue(tenant as never);

      await controller.create(req, res);

      expect(tenantService.create).toHaveBeenCalledWith({ slug: 'acme-corp', name: 'Acme Corp' });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: tenant }));
    });

    it('P5 — body tidak valid (slug mengandung huruf besar) dilempar sebagai error validasi', async () => {
      const req = { body: { slug: 'Acme-Corp', name: 'Acme' } } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.create(req, res)).rejects.toThrow();
      expect(tenantService.create).not.toHaveBeenCalled();
    });
  });

  describe('updatePlan (item 2.11)', () => {
    it('memvalidasi body, memanggil service dengan id dari URL, membalas 200', async () => {
      const req = {
        params: { id: 'tenant-1' },
        body: { plan: 'ENTERPRISE' },
      } as unknown as Request;
      const res = createMockResponse();
      const tenant = { id: 'tenant-1', plan: 'ENTERPRISE' };
      tenantService.updatePlan.mockResolvedValue(tenant as never);

      await controller.updatePlan(req, res);

      expect(tenantService.updatePlan).toHaveBeenCalledWith('tenant-1', 'ENTERPRISE');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: tenant }));
    });

    it('plan tidak valid dilempar sebagai error validasi, service TIDAK dipanggil', async () => {
      const req = { params: { id: 'tenant-1' }, body: { plan: 'GOLD' } } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.updatePlan(req, res)).rejects.toThrow();
      expect(tenantService.updatePlan).not.toHaveBeenCalled();
    });
  });
});
