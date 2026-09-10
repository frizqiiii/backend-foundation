-- Phase 1 (Auth Professional Upgrade): tambah nilai enum baru supaya
-- percobaan login yang GAGAL (password salah, atau email belum
-- diverifikasi) untuk akun yang benar-benar ada bisa direkam dan
-- tampil di GET /auth/login-history bersama LOGIN/LOGOUT sukses.
-- ALTER TYPE ... ADD VALUE tidak bisa dijalankan di dalam transaksi
-- eksplisit yang sama dengan statement lain, jadi migration ini
-- SENGAJA hanya berisi satu statement ini saja.
ALTER TYPE "AuditAction" ADD VALUE 'LOGIN_FAILED';
