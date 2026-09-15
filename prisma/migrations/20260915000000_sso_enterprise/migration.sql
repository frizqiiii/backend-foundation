-- Fase 2 (Kelompok 2 — Enterprise Features) — Enterprise SSO (OIDC).
-- Lihat komentar lengkap di prisma/schema.prisma (model SsoConnection
-- & SsoIdentity) untuk desain & alasannya. Ringkasan:
--   - `sso_connections`: SATU konfigurasi OIDC per tenant (issuer,
--     client_id, client_secret TERENKRIPSI lewat EncryptionService
--     aplikasi — kolomnya sendiri di database ini POLOS/text biasa,
--     bukan `pgcrypto` — enkripsi terjadi di application layer
--     sebelum INSERT, sama persis pola `users.mfa_secret`).
--   - `sso_identities`: tautan User <-> `sub` (subject) OIDC,
--     SENGAJA dipisah dari `users` (pola sama dengan `oauth_accounts`)
--     supaya identitas provider yang immutable tidak tercampur dengan
--     data User yang bisa berubah (email, dst).
--   - KEDUA tabel ini SENGAJA TIDAK dimasukkan ke RLS
--     (`enable_rls_multi_tenancy`) — sama seperti `users`/`tenants`
--     sendiri: keduanya diakses lewat jalur auth (login SSO) SEBELUM
--     tenant context penuh terbentuk untuk request itu, isolasi
--     tenant-nya ditegakkan di application layer (`SsoService`),
--     bukan lewat policy database untuk iterasi pertama ini.

CREATE TABLE "sso_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "issuer_url" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_encrypted" TEXT NOT NULL,
    "allowed_email_domain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sso_connections_tenant_id_key" ON "sso_connections"("tenant_id");

ALTER TABLE "sso_connections"
  ADD CONSTRAINT "sso_connections_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sso_identities" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sso_identities_tenant_id_subject_key" ON "sso_identities"("tenant_id", "subject");
CREATE INDEX "sso_identities_user_id_idx" ON "sso_identities"("user_id");

ALTER TABLE "sso_identities"
  ADD CONSTRAINT "sso_identities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
