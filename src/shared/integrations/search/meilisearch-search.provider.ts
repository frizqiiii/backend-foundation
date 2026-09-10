import { env } from '../../config/env';
import { logger } from '../../logger';
import type { SearchProvider, SearchDocument } from './search.provider';

/**
 * Meilisearch (https://www.meilisearch.com/docs/reference/api/documents)
 * lewat `fetch` langsung, TANPA SDK resmi — sama alasannya seperti
 * provider lain di Phase 15 ini. Meilisearch dipilih sebagai contoh
 * "real search engine" (bukan Elasticsearch/Algolia) karena API-nya
 * paling sederhana untuk didemonstrasikan lewat `fetch` polos (JSON
 * REST + Bearer token, tanpa kompleksitas cluster/index-template ala
 * Elasticsearch) DAN bisa di-self-host (tidak terikat satu vendor
 * SaaS seperti Algolia).
 */
export const meilisearchSearchProvider: SearchProvider = {
  async upsert(indexName: string, document: SearchDocument): Promise<void> {
    await request(`/indexes/${indexName}/documents`, 'POST', [document]);
  },

  async search(indexName: string, query: string): Promise<SearchDocument[]> {
    const result = await request<{ hits: SearchDocument[] }>(
      `/indexes/${indexName}/search`,
      'POST',
      { q: query }
    );
    return result.hits;
  },

  async deleteDocument(indexName: string, id: string): Promise<void> {
    await request(`/indexes/${indexName}/documents/${id}`, 'DELETE');
  },
};

async function request<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`${env.MEILISEARCH_HOST}${path}`, {
    method,
    headers: {
      ...(env.MEILISEARCH_API_KEY ? { Authorization: `Bearer ${env.MEILISEARCH_API_KEY}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    logger.error(
      { status: response.status, body: responseBody, path },
      'MeilisearchSearchProvider: request gagal'
    );
    throw new Error(`Meilisearch API mengembalikan status ${response.status}`);
  }

  // `DELETE` Meilisearch mengembalikan body kosong dengan status 202 —
  // `.json()` akan melempar error kalau dipaksa parse body kosong.
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}
