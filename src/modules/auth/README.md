# Authentication Module

Bertanggung jawab penuh atas siklus hidup kredensial & token di
seluruh aplikasi: register, login, refresh, logout, dan RBAC.

## Endpoint

| Method | Path                | Proteksi                  | Keterangan                          |
|--------|---------------------|----------------------------|--------------------------------------|
| POST   | `/api/auth/register` | Publik                    | Buat akun baru (role default `USER`) |
| POST   | `/api/auth/login`    | Publik                    | Terbitkan access + refresh token     |
| POST   | `/api/auth/refresh`  | Publik (butuh refreshToken) | Tukar refresh token → pasangan token baru (rotasi) |
| POST   | `/api/auth/logout`   | `authMiddleware`           | Cabut satu refresh token (sesi)       |

## Model token

- **Access token** — JWT umur pendek (`JWT_EXPIRES_IN`), berisi
  `{ id, email, role }`, dipakai di header `Authorization: Bearer`.
- **Refresh token** — string acak (bukan JWT), umur 7 hari, disimpan
  sebagai HASH SHA-256 di tabel `refresh_tokens`. Setiap pemakaian di
  `/refresh` memicu ROTASI (token lama langsung di-revoke) plus
  deteksi reuse: token yang sudah revoked tapi dipakai lagi akan
  mencabut seluruh sesi user tersebut.

## RBAC

Dua middleware otorisasi tersedia berdampingan (lihat komentar lengkap
di `shared/middlewares/permission.middleware.ts`): `requireRole(...roles)`
untuk kasus biner sederhana ("hanya role X"), dan
`requirePermission(permission)` untuk otorisasi berbasis kapabilitas.
Keduanya membaca `req.user.role`/permission yang sudah ditempel
`authMiddleware` dari payload JWT — tanpa query database tambahan.

**Status saat ini**: SELURUH rute yang sudah ada sudah bermigrasi
memakai `requirePermission` (mis. `GET /api/users` sekarang memakai
`requirePermission('user.manage')`, BUKAN lagi `requireRole('ADMIN')`
seperti sebelumnya) — `requireRole` tersedia sebagai utility untuk
kasus biner baru di masa depan, bukan sedang dipakai di rute manapun
saat ini.

## Batasan yang diketahui (belum dikerjakan)

- Perubahan role user baru berlaku setelah re-login (access token lama
  tetap membawa role lama sampai expired).
- Tidak ada rate limiting di endpoint ini — direncanakan di poin #9
  (`express-rate-limit` pada `/auth/*`).
