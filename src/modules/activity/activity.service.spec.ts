import { ActivityService } from './activity.service';
import type { ActivityRepository } from './activity.repository';

function createMockRepository(): jest.Mocked<ActivityRepository> {
  return { create: jest.fn() } as unknown as jest.Mocked<ActivityRepository>;
}

const actor = { userId: 'user-1', ipAddress: '127.0.0.1', userAgent: 'jest' };

describe('ActivityService', () => {
  it('logFileUpload mencatat type FILE_UPLOAD beserta metadata', async () => {
    const repository = createMockRepository();
    const service = new ActivityService(repository);

    await service.logFileUpload('Mengupload file avatar.png', actor, { sizeBytes: 1024 });

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      type: 'FILE_UPLOAD',
      description: 'Mengupload file avatar.png',
      metadata: { sizeBytes: 1024 },
    });
  });

  it('logAuthActivity mencatat type AUTH_ACTIVITY', async () => {
    const repository = createMockRepository();
    const service = new ActivityService(repository);

    await service.logAuthActivity('User login berhasil', actor);

    expect(repository.create).toHaveBeenCalledWith({
      ...actor,
      type: 'AUTH_ACTIVITY',
      description: 'User login berhasil',
      metadata: undefined,
    });
  });

  it('TIDAK melempar error ke pemanggil ketika repository gagal', async () => {
    const repository = createMockRepository();
    repository.create.mockRejectedValueOnce(new Error('DB down'));
    const service = new ActivityService(repository);

    await expect(service.logUserActivity('aktivitas apa pun', actor)).resolves.toBeUndefined();
  });
});
