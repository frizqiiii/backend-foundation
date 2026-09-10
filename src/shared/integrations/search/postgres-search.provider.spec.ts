import { postgresSearchProvider } from './postgres-search.provider';
import { prisma } from '../../config/database';
import type { SearchDocument } from './search.provider';

jest.mock('../../config/database', () => ({
  prisma: {
    searchDocument: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

const mockedPrisma = prisma as unknown as {
  searchDocument: { upsert: jest.Mock; findMany: jest.Mock; delete: jest.Mock };
};

const document: SearchDocument = { id: 'doc-1', title: 'Konser Musik', location: 'Jakarta' };

describe('postgresSearchProvider', () => {
  describe('upsert', () => {
    it('menggabungkan seluruh nilai string dokumen jadi searchText lowercase, lalu upsert', async () => {
      await postgresSearchProvider.upsert('events', document);

      expect(mockedPrisma.searchDocument.upsert).toHaveBeenCalledWith({
        where: { indexName_documentId: { indexName: 'events', documentId: 'doc-1' } },
        create: {
          indexName: 'events',
          documentId: 'doc-1',
          searchText: 'doc-1 konser musik jakarta',
          content: document,
        },
        update: {
          searchText: 'doc-1 konser musik jakarta',
          content: document,
        },
      });
    });

    it('P5 — mengabaikan nilai non-string (angka/boolean/nested object) saat membangun searchText', async () => {
      const mixedDoc = {
        id: 'doc-2',
        title: 'Produk',
        price: 1000,
        active: true,
      } as unknown as SearchDocument;

      await postgresSearchProvider.upsert('products', mixedDoc);

      const call = mockedPrisma.searchDocument.upsert.mock.calls[0][0];
      expect(call.create.searchText).toBe('doc-2 produk');
    });
  });

  describe('search', () => {
    it('mencari dengan ILIKE (contains, di-lowercase) dibatasi 50 hasil, diurutkan updatedAt terbaru', async () => {
      mockedPrisma.searchDocument.findMany.mockResolvedValue([
        { content: document },
        { content: { id: 'doc-3', title: 'Konser Lain' } },
      ]);

      const results = await postgresSearchProvider.search('events', 'KONSER');

      expect(mockedPrisma.searchDocument.findMany).toHaveBeenCalledWith({
        where: { indexName: 'events', searchText: { contains: 'konser' } },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });
      expect(results).toEqual([document, { id: 'doc-3', title: 'Konser Lain' }]);
    });

    it('mengembalikan array kosong kalau tidak ada dokumen yang cocok', async () => {
      mockedPrisma.searchDocument.findMany.mockResolvedValue([]);

      const results = await postgresSearchProvider.search('events', 'tidak-ada');

      expect(results).toEqual([]);
    });
  });

  describe('deleteDocument', () => {
    it('menghapus dokumen yang ada', async () => {
      mockedPrisma.searchDocument.delete.mockResolvedValue({});

      await postgresSearchProvider.deleteDocument('events', 'doc-1');

      expect(mockedPrisma.searchDocument.delete).toHaveBeenCalledWith({
        where: { indexName_documentId: { indexName: 'events', documentId: 'doc-1' } },
      });
    });

    it('P5 — idempotent: delete pada dokumen yang TIDAK ADA tidak melempar error (di-catch diam-diam)', async () => {
      mockedPrisma.searchDocument.delete.mockRejectedValue(new Error('Record not found'));

      await expect(
        postgresSearchProvider.deleteDocument('events', 'tidak-ada')
      ).resolves.toBeUndefined();
    });
  });
});
