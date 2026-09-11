import type { PrismaClient } from '@prisma/client';
import { ExportRepository } from './export.repository';

function createMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    exportJob: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('ExportRepository', () => {
  it('create membuat job dengan status QUEUED', async () => {
    const prisma = createMockPrisma();
    const created = { id: 'e1', status: 'QUEUED' };
    (prisma.exportJob.create as jest.Mock).mockResolvedValue(created);
    const repository = new ExportRepository(prisma);

    const result = await repository.create({
      userId: 'u1',
      tenantId: null,
      type: 'EVENTS' as never,
      format: 'CSV' as never,
    });

    expect(prisma.exportJob.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        tenantId: null,
        type: 'EVENTS',
        format: 'CSV',
        status: 'QUEUED',
      },
    });
    expect(result).toBe(created);
  });

  it('findById mencari job berdasarkan id, tanpa scoping user', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.findUnique as jest.Mock).mockResolvedValue(null);
    const repository = new ExportRepository(prisma);

    await repository.findById('e1');

    expect(prisma.exportJob.findUnique).toHaveBeenCalledWith({ where: { id: 'e1' } });
  });

  it('findByIdForUser menyertakan userId di where (mencegah user lain mengintip job)', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.findFirst as jest.Mock).mockResolvedValue(null);
    const repository = new ExportRepository(prisma);

    await repository.findByIdForUser('e1', 'u1');

    expect(prisma.exportJob.findFirst).toHaveBeenCalledWith({ where: { id: 'e1', userId: 'u1' } });
  });

  it('markProcessing mengubah status jadi PROCESSING', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.update as jest.Mock).mockResolvedValue({});
    const repository = new ExportRepository(prisma);

    await repository.markProcessing('e1');

    expect(prisma.exportJob.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { status: 'PROCESSING' },
    });
  });

  it('markCompleted mengisi status COMPLETED, fileUrl, dan completedAt', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.update as jest.Mock).mockResolvedValue({});
    const repository = new ExportRepository(prisma);

    await repository.markCompleted('e1', 'https://cdn.example.com/e1.csv');

    expect(prisma.exportJob.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: {
        status: 'COMPLETED',
        fileUrl: 'https://cdn.example.com/e1.csv',
        completedAt: expect.any(Date),
      },
    });
  });

  it('markFailed mengisi status FAILED, errorMessage, dan completedAt', async () => {
    const prisma = createMockPrisma();
    (prisma.exportJob.update as jest.Mock).mockResolvedValue({});
    const repository = new ExportRepository(prisma);

    await repository.markFailed('e1', 'timeout');

    expect(prisma.exportJob.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: {
        status: 'FAILED',
        errorMessage: 'timeout',
        completedAt: expect.any(Date),
      },
    });
  });
});
