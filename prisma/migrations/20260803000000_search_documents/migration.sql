-- Phase 15 (Enterprise Integration) — tabel generik untuk
-- PostgresSearchProvider (default SearchProvider, tidak butuh
-- infrastruktur tambahan). Lihat komentar lengkap di schema.prisma.

CREATE TABLE "search_documents" (
    "id" TEXT NOT NULL,
    "index_name" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "search_text" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "search_documents_index_name_document_id_key" ON "search_documents"("index_name", "document_id");
CREATE INDEX "search_documents_index_name_idx" ON "search_documents"("index_name");
