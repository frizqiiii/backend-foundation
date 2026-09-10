import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import type { MfaService } from './mfa.service';
import type { UserRepository } from '../users/user.repository';
import { confirmMfaSetupSchema, disableMfaSchema } from './mfa.dto';
import { sendSuccess } from '../../shared/utils/response';
import { NotFoundError, UnauthorizedError } from '../../shared/utils/http-error';

/**
 * Seluruh endpoint di sini SELALU beroperasi pada `req.user` (user
 * yang sedang login lewat `authMiddleware`) — TIDAK PERNAH menerima
 * `userId` dari body/param. MFA adalah pengaturan akun sendiri, tidak
 * ada skenario "ADMIN mengaktifkan MFA untuk user lain" di fase ini
 * (beda dari `TenantController` yang memang operasi admin lintas
 * user).
 */
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly userRepository: UserRepository
  ) {}

  setup = async (req: Request, res: Response): Promise<void> => {
    const user = await this.getRequestUser(req);
    const result = await this.mfaService.beginSetup(user);
    sendSuccess(
      res,
      200,
      'Scan otpauthUrl sebagai QR code (atau masukkan secret manual) di authenticator app Anda, lalu konfirmasi lewat POST /auth/mfa/confirm',
      result
    );
  };

  confirm = async (req: Request, res: Response): Promise<void> => {
    const input = confirmMfaSetupSchema.parse(req.body);
    const user = await this.getRequestUser(req);
    const recoveryCodes = await this.mfaService.confirmSetup(user, input.code);

    sendSuccess(
      res,
      200,
      'MFA berhasil diaktifkan. SIMPAN kode pemulihan berikut di tempat aman — kode ini TIDAK akan ditampilkan lagi.',
      { recoveryCodes }
    );
  };

  disable = async (req: Request, res: Response): Promise<void> => {
    const input = disableMfaSchema.parse(req.body);
    const user = await this.getRequestUser(req);

    // Re-autentikasi wajib pakai password — lihat alasan lengkap di
    // komentar `disableMfaSchema` (mfa.dto.ts): mewajibkan kode TOTP
    // untuk aksi ini akan mengunci user yang justru kehilangan akses
    // ke authenticator app-nya.
    if (!user.password || !(await bcrypt.compare(input.password, user.password))) {
      throw new UnauthorizedError('Password salah');
    }

    await this.mfaService.disable(user);
    sendSuccess(res, 200, 'MFA berhasil dinonaktifkan', null);
  };

  private async getRequestUser(req: Request) {
    // `authMiddleware` (dipasang di routes) memastikan `req.user` ada
    // sebelum controller manapun di modul ini dipanggil — guard ini
    // murni untuk TypeScript (dan pertahanan berlapis kalau suatu saat
    // rute ini didaftarkan tanpa middleware tersebut), pola yang sama
    // dengan `AuthController.logout`/`listSessions`.
    if (!req.user) {
      throw new UnauthorizedError();
    }
    const user = await this.userRepository.findById(req.user.id);
    if (!user) {
      throw new NotFoundError('User tidak ditemukan');
    }
    return user;
  }
}
