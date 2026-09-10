-- Phase 11 upgrade (Database Optimization): composite index untuk
-- melayani query `AuditRepository.findByUser` (login history) tanpa
-- langkah sort tambahan. Lihat komentar di schema.prisma.
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");
