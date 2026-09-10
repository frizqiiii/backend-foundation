import type { Request } from 'express';

/**
 * Mengambil IP address client secara konsisten di seluruh aplikasi —
 * dipakai oleh AuditService/ActivityService (Phase 5) supaya setiap
 * pemanggil tidak menulis ulang logika yang sama.
 *
 * `req.ip` (bukan `req.socket.remoteAddress` langsung) SENGAJA
 * dipakai sebagai sumber utama — Express sudah menghormati header
 * `X-Forwarded-For` ketika `app.set('trust proxy', ...)` diaktifkan
 * (relevan untuk deployment di belakang Nginx/load balancer, lihat
 * `deploy/nginx`), jadi tidak perlu mem-parsing header itu manual di
 * sini dan berisiko salah kalau ada banyak proxy di depan.
 */
export function getClientIp(req: Request): string | null {
  return req.ip ?? null;
}

/**
 * Mengambil header `User-Agent` — nullable karena bukan header wajib
 * (client non-browser seperti curl/script bisa saja tidak
 * mengirimkannya sama sekali).
 */
export function getUserAgent(req: Request): string | null {
  return req.get('user-agent') ?? null;
}
