-- Phase 17 lanjutan (Suspicious Session Detection): tambah 1 nilai
-- enum baru untuk menandai login berhasil dari device (kombinasi
-- IP address + User-Agent) yang belum pernah tercatat sebelumnya
-- untuk user tsb — lihat AuthService.detectAndRecordSuspiciousLogin.
-- ALTER TYPE ... ADD VALUE tidak bisa dijalankan di dalam transaksi
-- eksplisit yang sama dengan statement lain, jadi migration ini
-- SENGAJA hanya berisi satu statement ini saja (pola sama persis
-- dengan migration 20260805000000_session_audit_actions).
ALTER TYPE "AuditAction" ADD VALUE 'SUSPICIOUS_LOGIN_DETECTED';
