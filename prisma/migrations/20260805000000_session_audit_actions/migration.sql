-- Phase 17 (Session Management Enterprise): tambah 2 nilai enum baru
-- supaya pencabutan sesi (satu device maupun logout-all-devices) bisa
-- direkam dan tampil di riwayat keamanan user bersama LOGIN/LOGOUT/
-- LOGIN_FAILED — lihat AuthService.revokeSession/revokeAllSessions.
-- ALTER TYPE ... ADD VALUE tidak bisa dijalankan di dalam transaksi
-- eksplisit yang sama dengan statement lain, jadi migration ini
-- SENGAJA hanya berisi statement-statement ini saja (pola sama persis
-- dengan migration 20260727000000_login_failed_audit_action).
ALTER TYPE "AuditAction" ADD VALUE 'SESSION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'SESSIONS_REVOKED_ALL';
