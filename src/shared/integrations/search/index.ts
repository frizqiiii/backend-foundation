import { env } from '../../config/env';
import type { SearchProvider } from './search.provider';
import { postgresSearchProvider } from './postgres-search.provider';
import { meilisearchSearchProvider } from './meilisearch-search.provider';

export type { SearchProvider, SearchDocument } from './search.provider';

function buildSearchProvider(): SearchProvider {
  // BEDA dari factory provider lain di Phase 15 — TIDAK ada fallback
  // "kredensial kosong → default", karena `postgresSearchProvider`
  // TIDAK butuh kredensial sama sekali (hanya PostgreSQL yang sudah
  // pasti ada). `SEARCH_PROVIDER=meilisearch` tanpa
  // `MEILISEARCH_HOST` yang valid akan gagal di request pertamanya
  // (bukan di-fallback diam-diam) — kegagalan koneksi ke Meilisearch
  // adalah error yang LEBIH BAIK terlihat jelas saat dipakai, bukan
  // disembunyikan jadi silently-wrong-provider seperti kredensial
  // API key kosong di provider lain.
  if (env.SEARCH_PROVIDER === 'meilisearch') {
    return meilisearchSearchProvider;
  }

  return postgresSearchProvider;
}

export const searchProvider: SearchProvider = buildSearchProvider();
