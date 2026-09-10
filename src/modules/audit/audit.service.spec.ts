import { AuditService } from './audit.service';
import type { AuditRepository } from './audit.repository';

function createMockRepository(): jest.Mocked<AuditRepository> {
  return { create: jest.fn(), findByUser: jest.fn() } as unknown as jest.Mocked<AuditRepository>;
}

const actor = { userId: 'user-1', ipAddress: '127.0.0.1', userAgent: 'jest' };

describe('AuditService', () => {
  it('logCreate meneruskan action CREATE beserta entity/entityId ke repository', async () => {
    const repository = createMockRepository();
    const service = new AuditService(repository);

    await service.logCreate('Event', 'event-1', actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      action: 'CREATE',
      entity: 'Event',
      entityId: 'event-1',
    });
  });

  it('logUpdate meneruskan action UPDATE beserta entity/entityId ke repository', async () => {
    const repository = createMockRepository();
    const service = new AuditService(repository);

    await service.logUpdate('Event', 'event-1', actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      action: 'UPDATE',
      entity: 'Event',
      entityId: 'event-1',
    });
  });

  it('logLogout memakai userId sebagai entityId, sama seperti logLogin', async () => {
    const repository = createMockRepository();
    const service = new AuditService(repository);

    await service.logLogout(actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      action: 'LOGOUT',
      entity: 'User',
      entityId: 'user-1',
    });
  });

  it('logSuspiciousLogin mencatat action SUSPICIOUS_LOGIN_DETECTED dengan entityId = userId', async () => {
    const repository = createMockRepository();
    const service = new AuditService(repository);

    await service.logSuspiciousLogin(actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      action: 'SUSPICIOUS_LOGIN_DETECTED',
      entity: 'User',
      entityId: 'user-1',
    });
  });

  it('logLogin memakai userId sebagai entityId agar tetap terindeks bersama audit CRUD', async () => {
    const repository = createMockRepository();
    const service = new AuditService(repository);

    await service.logLogin(actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      action: 'LOGIN',
      entity: 'User',
      entityId: 'user-1',
    });
  });

  it('logLoginFailed mencatat action LOGIN_FAILED dengan entityId = userId, sama seperti logLogin', async () => {
    const repository = createMockRepository();
    const service = new AuditService(repository);

    await service.logLoginFailed(actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      action: 'LOGIN_FAILED',
      entity: 'User',
      entityId: 'user-1',
    });
  });

  it('logSessionRevoked mencatat action SESSION_REVOKED dengan entityId = sessionId (Phase 17)', async () => {
    const repository = createMockRepository();
    const service = new AuditService(repository);

    await service.logSessionRevoked('session-99', actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      action: 'SESSION_REVOKED',
      entity: 'RefreshToken',
      entityId: 'session-99',
    });
  });

  it('logAllSessionsRevoked memakai userId sebagai entityId, sama seperti logLogin (Phase 17)', async () => {
    const repository = createMockRepository();
    const service = new AuditService(repository);

    await service.logAllSessionsRevoked(actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      action: 'SESSIONS_REVOKED_ALL',
      entity: 'User',
      entityId: 'user-1',
    });
  });

  it('TIDAK melempar error ke pemanggil ketika repository gagal — hanya di-log', async () => {
    const repository = createMockRepository();
    repository.create.mockRejectedValueOnce(new Error('DB down'));
    const service = new AuditService(repository);

    await expect(service.logDelete('Product', 'product-1', actor)).resolves.toBeUndefined();
  });

  describe('getLoginHistory', () => {
    it('mengembalikan data yang dipetakan (dengan field success turunan) beserta meta pagination yang benar', async () => {
      const repository = createMockRepository();
      const entries = [
        { action: 'LOGIN', ipAddress: '127.0.0.1', userAgent: 'jest', createdAt: new Date() },
        {
          action: 'LOGIN_FAILED',
          ipAddress: '203.0.113.9',
          userAgent: 'curl',
          createdAt: new Date(),
        },
      ];
      repository.findByUser.mockResolvedValue({ data: entries as never, total: 25 });
      const service = new AuditService(repository);

      const result = await service.getLoginHistory('user-1', { page: 2, limit: 10 });

      expect(repository.findByUser).toHaveBeenCalledWith('user-1', { page: 2, limit: 10 });
      expect(result.data).toEqual([
        { ...entries[0], success: true },
        { ...entries[1], success: false },
      ]);
      expect(result.meta).toEqual({ page: 2, limit: 10, total: 25, totalPages: 3 });
    });

    it('MELEMPAR error apa adanya ketika repository gagal — beda dari method log* di atas, ini pembacaan yang hasilnya langsung dikirim ke user', async () => {
      const repository = createMockRepository();
      repository.findByUser.mockRejectedValueOnce(new Error('DB down'));
      const service = new AuditService(repository);

      await expect(service.getLoginHistory('user-1', { page: 1, limit: 20 })).rejects.toThrow(
        'DB down'
      );
    });
  });
});
