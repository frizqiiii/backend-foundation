/**
 * Search Engine Provider (Phase 15 — Enterprise Integration).
 *
 * Beda dari provider lain di fase ini (email/SMS/push/payment — semua
 * "fire and forget" satu arah), search punya SIKLUS HIDUP dokumen
 * penuh: `upsert` (index dokumen baru/perbarui yang sudah ada),
 * `search` (query), `deleteDocument` (hapus dari index). SEMUA
 * implementasi (Postgres, Meilisearch) mengikuti kontrak yang SAMA
 * ini — pemanggil tidak pernah tahu/peduli yang mana yang aktif.
 */
export interface SearchDocument {
  id: string;
  [key: string]: unknown;
}

export interface SearchProvider {
  /** Index dokumen baru, atau perbarui kalau `document.id` sudah ada
   * di `indexName` yang sama (upsert, bukan insert-only). */
  upsert(indexName: string, document: SearchDocument): Promise<void>;
  search(indexName: string, query: string): Promise<SearchDocument[]>;
  deleteDocument(indexName: string, id: string): Promise<void>;
}
