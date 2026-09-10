import { prisma } from '../../config/database';
import type { SearchProvider, SearchDocument } from './search.provider';

/**
 * Default SearchProvider — didukung tabel `SearchDocument` (lihat
 * schema.prisma), TIDAK butuh service tambahan apa pun di luar
 * PostgreSQL yang sudah dipakai aplikasi ini untuk semuanya.
 *
 * KEJUJURAN SOAL KETERBATASAN — `search()` di bawah memakai `contains`
 * (SQL `ILIKE '%query%'`), BUKAN full-text search PostgreSQL
 * sungguhan (`tsvector`/`to_tsquery` + GIN index). Ini SENGAJA:
 * `ILIKE` cukup untuk skala kecil-menengah dan TIDAK butuh migrasi
 * skema tambahan (kolom `tsvector` generated, GIN index) yang lebih
 * rumit untuk fondasi awal. Trade-off yang disadari: TIDAK ada
 * relevance ranking (hasil diurutkan `updatedAt` terbaru, bukan
 * seberapa relevan), TIDAK ada stemming/fuzzy matching, dan `ILIKE`
 * tanpa index yang sesuai bisa lambat di tabel besar (full table
 * scan). Untuk kebutuhan search yang lebih serius (relevansi,
 * typo-tolerance, kecepatan di jutaan dokumen), pakai
 * `MeilisearchSearchProvider` (`SEARCH_PROVIDER=meilisearch`).
 */
export const postgresSearchProvider: SearchProvider = {
  async upsert(indexName: string, document: SearchDocument): Promise<void> {
    await prisma.searchDocument.upsert({
      where: { indexName_documentId: { indexName, documentId: document.id } },
      create: {
        indexName,
        documentId: document.id,
        searchText: buildSearchText(document),
        content: document as never,
      },
      update: {
        searchText: buildSearchText(document),
        content: document as never,
      },
    });
  },

  async search(indexName: string, query: string): Promise<SearchDocument[]> {
    const rows = await prisma.searchDocument.findMany({
      where: { indexName, searchText: { contains: query.toLowerCase() } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return rows.map((row: { content: unknown }) => row.content as SearchDocument);
  },

  async deleteDocument(indexName: string, id: string): Promise<void> {
    await prisma.searchDocument
      .delete({ where: { indexName_documentId: { indexName, documentId: id } } })
      .catch(() => {
        // Idempotent — hapus dokumen yang sudah tidak ada (mis. dua
        // request delete beriringan) bukan error bagi pemanggil.
      });
  },
};

/**
 * Menggabungkan SELURUH nilai string di dokumen jadi satu teks
 * pencarian, di-lowercase (`contains` PostgreSQL case-sensitive
 * secara default) — pendekatan generik yang tidak perlu tahu field
 * mana yang "harus" dicari untuk index tertentu, konsisten dengan
 * sifat `SearchDocument` yang sengaja generik.
 */
function buildSearchText(document: SearchDocument): string {
  return Object.values(document)
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}
