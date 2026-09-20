import type { Request, Response } from 'express';
import { TenantController } from './tenant.controller';
import type { TenantService } from './tenant.service';
import type { AuditService } from '../audit/audit.service';
import { UnauthorizedError } from '../../shared/utils/http-error';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('TenantController', () => {
  let tenantService: jest.Mocked<TenantService>;
  let auditService: jest.Mocked<AuditService>;
  let controller: TenantController;

  beforeEach(() => {
    tenantService = {
      list: jest.fn(),
      create: jest.fn(),
      updatePlan: jest.fn(),
    } as unknown as jest.Mocked<TenantService>;
    auditService = { logUpdate: jest.fn() } as unknown as jest.Mocked<AuditService>;
    controller = new TenantController(tenantService, auditService);
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

  describe('updatePlan (item 2.11 + temuan T2)', () => {
    function reqFor(body: unknown, user: unknown = { id: 'admin-1' }): Request {
      return {
        params: { id: 'tenant-1' },
        body,
        user,
        headers: { 'user-agent': 'jest-agent' },
        get: (header: string) => (header.toLowerCase() === 'user-agent' ? 'jest-agent' : undefined),
        ip: '10.0.0.7',
        socket: { remoteAddress: '10.0.0.7' },
      } as unknown as Request;
    }

    it('memvalidasi body, memanggil service dengan id dari URL, membalas 200', async () => {
      const res = createMockResponse();
      const tenant = { id: 'tenant-1', plan: 'ENTERPRISE' };
      tenantService.updatePlan.mockResolvedValue({ tenant, previousPlan: 'PRO' } as never);

      await controller.updatePlan(reqFor({ plan: 'ENTERPRISE' }), res);

      expect(tenantService.updatePlan).toHaveBeenCalledWith('tenant-1', 'ENTERPRISE');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: tenant }));
    });

    it('T2 — mencatat audit UPDATE pada entity Tenant: siapa (userId), dari plan apa ke plan apa (details)', async () => {
      const res = createMockResponse();
      tenantService.updatePlan.mockResolvedValue({
        tenant: { id: 'tenant-1', plan: 'ENTERPRISE' },
        previousPlan: 'FREE',
      } as never);

      await controller.updatePlan(reqFor({ plan: 'ENTERPRISE' }), res);

      expect(auditService.logUpdate).toHaveBeenCalledTimes(1);
      expect(auditService.logUpdate).toHaveBeenCalledWith(
        'Tenant',
        'tenant-1',
        expect.objectContaining({ userId: 'admin-1', userAgent: 'jest-agent' }),
        { field: 'plan', from: 'FREE', to: 'ENTERPRISE' }
      );
    });

    it('T2 — PATCH yang tidak mengubah nilai (from == to) TETAP dicatat (aksi admin tetap bisa ditelusuri)', async () => {
      const res = createMockResponse();
      tenantService.updatePlan.mockResolvedValue({
        tenant: { id: 'tenant-1', plan: 'PRO' },
        previousPlan: 'PRO',
      } as never);

      await controller.updatePlan(reqFor({ plan: 'PRO' }), res);

      expect(auditService.logUpdate).toHaveBeenCalledWith('Tenant', 'tenant-1', expect.anything(), {
        field: 'plan',
        from: 'PRO',
        to: 'PRO',
      });
    });

    it('T2 — plan tidak valid: error validasi, service DAN audit TIDAK dipanggil', async () => {
      const res = createMockResponse();

      await expect(controller.updatePlan(reqFor({ plan: 'GOLD' }), res)).rejects.toThrow();
      expect(tenantService.updatePlan).not.toHaveBeenCalled();
      expect(auditService.logUpdate).not.toHaveBeenCalled();
    });

    it('T2 — service gagal (mis. tenant tidak ada): TIDAK ada audit dicatat untuk aksi yang tidak terjadi', async () => {
      const res = createMockResponse();
      tenantService.updatePlan.mockRejectedValue(new Error('Tenant tidak ditemukan'));

      await expect(controller.updatePlan(reqFor({ plan: 'FREE' }), res)).rejects.toThrow();
      expect(auditService.logUpdate).not.toHaveBeenCalled();
    });

    it('T2 — tanpa req.user (seharusnya mustahil setelah authMiddleware) -> UnauthorizedError, tidak menulis apa pun', async () => {
      const res = createMockResponse();

      await expect(controller.updatePlan(reqFor({ plan: 'FREE' }, null), res)).rejects.toThrow(
        UnauthorizedError
      );
      expect(tenantService.updatePlan).not.toHaveBeenCalled();
      expect(auditService.logUpdate).not.toHaveBeenCalled();
    });
  });
});
