import type { UserRepository } from './user.repository';
import type { UserResponseDto, ListUsersQueryDto } from './user.dto';
import { NotFoundError } from '../../shared/utils/http-error';
import { getOrSetCache, invalidateCache } from '../../shared/utils/cache';
import { cacheKeys } from '../../shared/utils/cache-keys';
import { pagination, buildPaginatedResult, type PaginatedResult } from '../../shared/pagination';

const USER_PROFILE_CACHE_TTL_SECONDS = 300; // 5 menit

/**
 * Service Layer modul `users`.
 *
 * Catatan konsolidasi (#2 — Auth): `registerUser` dan `login`
 * sebelumnya ada di sini, sudah DIPINDAH ke `modules/auth/auth.service.ts`
 * agar seluruh siklus hidup kredensial & token berada di satu tempat.
 * `users` sekarang murni tentang data profil.
 */
export class UserService {
  constructor(private readonly userRepository: UserRepository) {}

  /**
   * Mengambil profil user yang sedang login, berdasarkan payload
   * yang sudah diverifikasi oleh `authMiddleware`. Di-cache 5 menit —
   * profil jarang berubah, dan endpoint ini kemungkinan besar paling
   * sering dipanggil (setiap kali frontend butuh info user aktif).
   * Invalidasi terjadi di `AuthService` (`verifyEmail`/
   * `resetPassword`), satu-satunya tempat lain yang mengubah data user.
   */
  async getProfile(userId: string): Promise<UserResponseDto> {
    return getOrSetCache(
      cacheKeys.userProfile(userId),
      USER_PROFILE_CACHE_TTL_SECONDS,
      async () => {
        const user = await this.userRepository.findById(userId);
        if (!user) {
          throw new NotFoundError('User tidak ditemukan');
        }
        return this.toResponseDto(user);
      }
    );
  }

  /**
   * Daftar user (Phase 3 — dipaginasi, sebelumnya `findAll()`
   * mengambil SELURUH baris tanpa batas sama sekali). Hanya dipanggil
   * dari rute yang sudah dibatasi `requirePermission('user.manage')`
   * di layer routing (lihat `user.routes.ts`). Service ini tidak
   * melakukan pengecekan permission apa pun sendiri — otorisasi
   * adalah tanggung jawab middleware, bukan business logic.
   */
  async listUsers(query: ListUsersQueryDto): Promise<PaginatedResult<UserResponseDto>> {
    const { data, total } = await this.userRepository.findMany(pagination(query.page, query.limit));
    return buildPaginatedResult(
      data.map((user) => this.toResponseDto(user)),
      total,
      query.page,
      query.limit
    );
  }

  /**
   * Soft delete (Phase 3) — hanya dipanggil dari rute
   * `requirePermission('user.manage')`, sama seperti `listUsers`.
   * Cache profil user ini langsung diinvalidasi supaya
   * `GET /users/me` tidak sempat mengembalikan data basi dari akun
   * yang baru saja dihapus (TTL cache profil 5 menit — terlalu lama
   * untuk dibiarkan kedaluwarsa sendiri di kasus ini).
   */
  async deleteUser(userId: string): Promise<void> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User tidak ditemukan');
    }

    await this.userRepository.delete(userId);
    await invalidateCache(cacheKeys.userProfile(userId));
  }

  /**
   * Memastikan password tidak pernah bocor ke response client,
   * di satu tempat yang eksplisit dan mudah diaudit.
   */
  private toResponseDto(user: {
    id: string;
    email: string;
    name: string;
    createdAt: Date;
  }): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    };
  }
}
