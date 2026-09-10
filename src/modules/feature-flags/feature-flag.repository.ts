import type { PrismaClient, FeatureFlag } from '@prisma/client';

export class FeatureFlagRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(): Promise<FeatureFlag[]> {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async findByKey(key: string): Promise<FeatureFlag | null> {
    return this.prisma.featureFlag.findUnique({ where: { key } });
  }

  async upsert(
    key: string,
    data: { enabled: boolean; description?: string }
  ): Promise<FeatureFlag> {
    return this.prisma.featureFlag.upsert({
      where: { key },
      create: { key, ...data },
      update: data,
    });
  }
}
