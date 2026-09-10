import { OAuth2Client } from 'google-auth-library';
import type { UserRepository } from '../users/user.repository';
import type { AuthRepository } from './auth.repository';
import type { AuthService } from './auth.service';
import type { AuthResponseDto } from './auth.dto';
import { env } from '../../shared/config/env';
import { BadRequestError, UnauthorizedError } from '../../shared/utils/http-error';
import type { OAuthProviderName } from '../../shared/types/oauth-provider';
import type { RoleName } from '../../shared/types/role';

/**
 * Shape User yang MINIMAL dibutuhkan modul ini — SENGAJA bukan tipe
 * `User` penuh dari `@prisma/client` (yang membawa banyak field lain
 * seperti `password`, `emailVerifiedAt`, dst yang tidak relevan di
 * sini). Sama seperti pola `RoleName`: Service layer tidak perlu tahu
 * bentuk lengkap hasil generate Prisma, cukup field yang benar-benar
 * dipakai — dalam hal ini, persis field yang dibutuhkan
 * `AuthService.issueTokensForUser`.
 */
interface OAuthUser {
  id: string;
  email: string;
  name: string;
  role: RoleName;
  createdAt: Date;
}

interface NormalizedOAuthProfile {
  providerAccountId: string;
  email: string;
  name: string;
}

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id: number;
  name: string | null;
  login: string;
  email: string | null;
}

interface GithubEmailEntry {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * Service Layer untuk login lewat provider OAuth eksternal (Google,
 * GitHub). Google dan GitHub memakai PROTOKOL YANG BERBEDA:
 * - Google: client mengirim `idToken` (JWT yang ditandatangani Google
 *   lewat Google Identity Services di sisi frontend) — backend HANYA
 *   perlu memverifikasi signature & audience-nya, tanpa panggilan
 *   jaringan tambahan ke Google.
 * - GitHub: TIDAK punya konsep id_token. Client mengirim `code` hasil
 *   redirect OAuth, backend HARUS menukarnya ke access_token (butuh
 *   CLIENT_SECRET, makanya harus di server) lalu memanggil GitHub API
 *   untuk profil user.
 *
 * Bergantung pada `AuthService` (bukan mengimplementasikan ulang
 * penerbitan token) — begitu identitas user terverifikasi lewat
 * provider mana pun, jalur menerbitkan access+refresh token harus
 * SAMA PERSIS dengan login password biasa (lihat
 * `AuthService.issueTokensForUser`).
 */
export class OAuthService {
  private readonly googleClient: OAuth2Client | null;

  constructor(
    private readonly userRepository: UserRepository,
    private readonly authRepository: AuthRepository,
    private readonly authService: AuthService
  ) {
    this.googleClient = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;
  }

  async loginWithGoogle(idToken: string): Promise<AuthResponseDto> {
    if (!this.googleClient) {
      throw new BadRequestError('Login Google belum dikonfigurasi di server ini.');
    }

    let payload;
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedError('Token Google tidak valid');
    }

    if (!payload || !payload.email) {
      throw new UnauthorizedError('Token Google tidak valid');
    }

    const user = await this.findOrCreateUser('GOOGLE', {
      providerAccountId: payload.sub,
      email: payload.email,
      name: payload.name ?? payload.email,
    });

    return this.authService.issueTokensForUser(user);
  }

  async loginWithGithub(code: string): Promise<AuthResponseDto> {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      throw new BadRequestError('Login GitHub belum dikonfigurasi di server ini.');
    }

    const accessToken = await this.exchangeGithubCode(code);
    const profile = await this.fetchGithubProfile(accessToken);

    const user = await this.findOrCreateUser('GITHUB', profile);

    return this.authService.issueTokensForUser(user);
  }

  private async exchangeGithubCode(code: string): Promise<string> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const data = (await response.json()) as GithubTokenResponse;

    if (!data.access_token) {
      throw new UnauthorizedError(
        `Kode otorisasi GitHub tidak valid${data.error_description ? `: ${data.error_description}` : ''}`
      );
    }

    return data.access_token;
  }

  private async fetchGithubProfile(accessToken: string): Promise<NormalizedOAuthProfile> {
    const userResponse = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'backend-foundation-app' },
    });

    if (!userResponse.ok) {
      throw new UnauthorizedError('Gagal mengambil profil GitHub');
    }

    const githubUser = (await userResponse.json()) as GithubUserResponse;

    let email = githubUser.email;
    if (!email) {
      // Banyak user GitHub menyembunyikan email utama dari profil
      // publik — perlu endpoint terpisah (butuh scope `user:email`)
      // untuk tetap mendapatkannya.
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'backend-foundation-app' },
      });
      if (emailsResponse.ok) {
        const emails = (await emailsResponse.json()) as GithubEmailEntry[];
        email = emails.find((e) => e.primary && e.verified)?.email ?? null;
      }
    }

    if (!email) {
      throw new UnauthorizedError(
        'Akun GitHub ini tidak memiliki email publik/terverifikasi yang bisa dipakai untuk login'
      );
    }

    return {
      providerAccountId: String(githubUser.id),
      email,
      name: githubUser.name ?? githubUser.login,
    };
  }

  /**
   * Alur cari-atau-buat user, sama untuk kedua provider:
   * 1. Sudah pernah login lewat provider ini persis? -> pakai user itu.
   * 2. Belum, tapi sudah ada User dengan email yang sama (mis. dulu
   *    daftar pakai password)? -> tautkan provider ini ke user
   *    tersebut (akun tergabung, bukan akun duplikat baru).
   * 3. Belum ada sama sekali -> buat User baru TANPA password
   *    (`password: null`) dan `emailVerifiedAt` langsung terisi —
   *    provider OAuth sudah membuktikan kepemilikan email tersebut,
   *    tidak perlu alur verifikasi email manual lagi.
   */
  private async findOrCreateUser(
    provider: OAuthProviderName,
    profile: NormalizedOAuthProfile
  ): Promise<OAuthUser> {
    const existingAccount = await this.authRepository.findOAuthAccount(
      provider,
      profile.providerAccountId
    );
    if (existingAccount) {
      const user = await this.userRepository.findById(existingAccount.userId);
      if (!user) {
        throw new UnauthorizedError('Akun tidak ditemukan');
      }
      return user;
    }

    let user = await this.userRepository.findByEmail(profile.email);
    if (!user) {
      user = await this.userRepository.create({
        email: profile.email,
        name: profile.name,
        password: null,
        emailVerifiedAt: new Date(),
      });
    }

    await this.authRepository.createOAuthAccount({
      provider,
      providerAccountId: profile.providerAccountId,
      userId: user.id,
    });

    return user;
  }
}
