-- P3 (Database Audit) — konsistensi konvensi: setiap model lain dengan
-- tenantId opsional (Product, Event, ApiKey, WebhookEndpoint) sudah
-- punya index tenantId sejak Phase 11; export_jobs sebelumnya tidak.
-- CreateIndex
CREATE INDEX "export_jobs_tenant_id_idx" ON "export_jobs"("tenant_id");
