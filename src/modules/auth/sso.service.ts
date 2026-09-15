import { Issuer, generators, type Client } from 'openid-client';
import type { TenantRepository } from '../tenants/tenant.repository';
import type { SsoConnectionRepository, SsoIdentityRepository } from './sso.repository';
import type { UserRepository } from '../users/user.repository';
import type { AuthService } from './auth.service';
import type { AuthResponseDto } from './auth.dto';
import type { RoleName } from '../../shared/types/role';
import { encryptionService } from '../../shared/security/encryption.service';
import { redisClient } from '../../shared/config/redis';
import { generateSecureToken } from '../../shared/utils/secure-token';
import { env } from '../../shared/config/env';
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/utils/http-error';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import type { UpsertSsoConnectionDto } from './sso.dto';

const STATE_TTL_SECONDS = 300; // 5 menit — cukup untuk user menyelesaikan login di IdP.
// Kode tukar sekali-pakai antara callback (backend) -> frontend -> /consume.
// Sengaja PENDEK (bukan 300 detik seperti state) — frontend seharusnya
// langsung menukarnya begitu redirect diterima, ini bukan window untuk
// menunggu aksi manual user seperti login di state di atas.
const EXCHANGE_CODE_TTL_SECONDS = 60;

interface SsoUser {
  id: string;
  email: string;
  name: string;
  role: RoleName;
  createdAt: Date;
}

/**
 * Bentuk publik `SsoConnection` yang aman dikembalikan lewat API —
 * SENGAJA TIDAK PERNAH menyertakan `clientSecretEncrypted` dalam
 * bentuk apa pun (bahkan terenkripsi) — begitu diset, admin hanya
 * bisa MENGGANTI-nya, tidak pernah membacanya lagi lewat endpoint
 * ini (pola yang sama dengan bagaimana password/mfaSecret tidak
 * pernah dikembalikan API manapun).
 */
interface PublicSsoConnection {
  tenantId: string;
  issuerUrl: string;
  clientId: string;
  allowedEmailDomain: string;
  enabled: boolean;
}

/**
 * Service Layer untuk KONFIGURASI SSO (admin platform, lewat
 * permission `sso.manage`) — terpisah dari `SsoService` (alur LOGIN
 * pengguna) di bawah, sama seperti `TenantService` terpisah dari
 * `AuthService`: mengelola pengaturan vs memakai pengaturan itu
 * adalah dua tanggung jawab berbeda.
 */
export class SsoConnectionService {
  constructor(
    private readonly ssoConnectionRepository: SsoConnectionRepository,
    private readonly tenantRepository: TenantRepository
  ) {}

  async upsert(tenantSlug: string, input: UpsertSsoConnectionDto): Promise<PublicSsoConnection> {
    const tenant = await this.tenantRepository.findBySlug(tenantSlug);
    if (!tenant) {
      throw new NotFoundError(`Tenant '${tenantSlug}' tidak ditemukan`);
    }

    const connection = await this.ssoConnectionRepository.upsert({
      tenantId: tenant.id,
      issuerUrl: input.issuerUrl,
      clientId: input.clientId,
      clientSecretEncrypted: encryptionService.encrypt(input.clientSecret),
      allowedEmailDomain: input.allowedEmailDomain.toLowerCase(),
      enabled: input.enabled,
    });

    return this.toPublic(connection);
  }

  async get(tenantSlug: string): Promise<PublicSsoConnection | null> {
    const tenant = await this.tenantRepository.findBySlug(tenantSlug);
    if (!tenant) {
      throw new NotFoundError(`Tenant '${tenantSlug}' tidak ditemukan`);
    }

    const connection = await this.ssoConnectionRepository.findByTenantId(tenant.id);
    return connection ? this.toPublic(connection) : null;
  }

  private toPublic(connection: {
    tenantId: string;
    issuerUrl: string;
    clientId: string;
    allowedEmailDomain: string;
    enabled: boolean;
  }): PublicSsoConnection {
    return {
      tenantId: connection.tenantId,
      issuerUrl: connection.issuerUrl,
      clientId: connection.clientId,
      allowedEmailDomain: connection.allowedEmailDomain,
      enabled: connection.enabled,
    };
  }
}

/**
 * Service Layer untuk alur LOGIN SSO (OIDC Authorization Code Flow +
 * PKCE) — dipakai endpoint publik `GET /auth/sso/:tenantSlug/login`,
 * `GET /auth/sso/:tenantSlug/callback`, `POST /auth/sso/consume`.
 *
 * KENAPA REDIS WAJIB (bukan opsional/fail-open seperti cache di
 * modul lain): `state`/`nonce`/`code_verifier` PKCE HARUS bertahan
 * lintas-request (redirect browser ke IdP lalu kembali lagi) dan
 * WAJIB tervalidasi persis — fail-open di sini berarti melewati
 * proteksi CSRF/replay OIDC itu sendiri, bukan sekadar performa yang
 * terdegradasi. Kalau Redis tidak ada, SSO menolak dengan pesan
 * jelas (lihat `requireRedis` di bawah), bukan diam-diam berjalan
 * tanpa proteksi ini.
 *
 * KENAPA KODE TUKAR SEKALI-PAKAI (bukan token langsung di URL
 * redirect ke frontend) — lihat komentar `SSO_FRONTEND_CALLBACK_URL`
 * di `env.ts`.
 */
export class SsoService {
  constructor(
    private readonly ssoConnectionRepository: SsoConnectionRepository,
    private readonly ssoIdentityRepository: SsoIdentityRepository,
    private readonly tenantRepository: TenantRepository,
    private readonly userRepository: UserRepository,
    private readonly authService: AuthService
  ) {}

  async buildAuthorizationUrl(tenantSlug: string): Promise<string> {
    const redis = this.requireRedis();
    const { tenant, connection } = await this.getActiveConnectionOrThrow(tenantSlug);
    const redirectUri = this.buildRedirectUri(tenantSlug);
    const client = await this.buildOidcClient(connection, redirectUri);

    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    await redis.set(
      `sso:state:${state}`,
      JSON.stringify({ tenantId: tenant.id, nonce, codeVerifier }),
      'EX',
      STATE_TTL_SECONDS
    );

    return client.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /**
   * Menangani redirect kembali dari IdP. Mengembalikan KODE TUKAR
   * sekali-pakai (string acak, BUKAN token) yang harus ditempelkan
   * Controller ke redirect `SSO_FRONTEND_CALLBACK_URL?code=...`.
   */
  async handleCallback(
    tenantSlug: string,
    query: { code?: string; state: string; error?: string; error_description?: string }
  ): Promise<string> {
    const redis = this.requireRedis();

    if (query.error) {
      throw new UnauthorizedError(
        `Login SSO ditolak oleh identity provider: ${query.error_description ?? query.error}`
      );
    }
    if (!query.code) {
      throw new BadRequestError('Parameter code tidak ada pada callback SSO.');
    }

    const stateKey = `sso:state:${query.state}`;
    const rawState = await redis.get(stateKey);
    if (!rawState) {
      throw new UnauthorizedError(
        'Sesi login SSO ini sudah kedaluwarsa, sudah dipakai, atau tidak valid — silakan login ulang.'
      );
    }
    // Single-use — dihapus SEGERA setelah ditemukan (kepakai atau
    // gagal di langkah berikutnya), bukan menunggu sampai seluruh
    // alur sukses. Mencegah `state` yang sama dipakai dua kali walau
    // percobaan pertama gagal di tengah jalan.
    await redis.del(stateKey);

    const stateData = JSON.parse(rawState) as {
      tenantId: string;
      nonce: string;
      codeVerifier: string;
    };

    const { connection } = await this.getActiveConnectionOrThrow(tenantSlug);
    // State ini HARUS untuk tenant yang SAMA seperti di path callback
    // — mencegah state yang diterbitkan untuk tenant A dipakai (mis.
    // lewat manipulasi URL) di callback tenant B.
    if (stateData.tenantId !== connection.tenantId) {
      throw new UnauthorizedError('State tidak cocok dengan tenant pada URL callback ini.');
    }

    const redirectUri = this.buildRedirectUri(tenantSlug);
    const client = await this.buildOidcClient(connection, redirectUri);

    const tokenSet = await client.callback(
      redirectUri,
      { code: query.code, state: query.state },
      { state: query.state, nonce: stateData.nonce, code_verifier: stateData.codeVerifier }
    );

    const claims = tokenSet.claims();
    const email = claims.email;
    if (!email) {
      throw new UnauthorizedError(
        'Identity provider tidak mengembalikan klaim email pada id_token.'
      );
    }
    if (!email.toLowerCase().endsWith(`@${connection.allowedEmailDomain.toLowerCase()}`)) {
      throw new ForbiddenError(
        `Email '${email}' bukan bagian dari domain yang diizinkan (${connection.allowedEmailDomain}) untuk tenant ini.`
      );
    }

    // Seluruh sisa alur (cari/buat User + terbitkan token) WAJIB
    // berjalan di dalam tenant context tenant ini — `UserRepository.
    // create` menyematkan `tenantId` dari context ini (lihat
    // `getTenantContext()` di `user.repository.ts`), BUKAN parameter
    // eksplisit.
    return runWithTenantContext(
      { tenantId: connection.tenantId, tenantSlug, db: null },
      async () => {
        const user = await this.findOrProvisionUser(
          connection.tenantId,
          claims.sub,
          email,
          (claims.name as string | undefined) ?? email
        );
        const authResponse = await this.authService.issueTokensForUser(user);

        const exchangeCode = generateSecureToken();
        await redis.set(
          `sso:exchange:${exchangeCode}`,
          JSON.stringify(authResponse),
          'EX',
          EXCHANGE_CODE_TTL_SECONDS
        );
        return exchangeCode;
      }
    );
  }

  /** Ditukar frontend segera setelah redirect callback diterima. */
  async consume(code: string): Promise<AuthResponseDto> {
    const redis = this.requireRedis();
    const key = `sso:exchange:${code}`;
    const raw = await redis.get(key);
    if (!raw) {
      throw new UnauthorizedError('Kode tukar SSO tidak valid, sudah dipakai, atau kedaluwarsa.');
    }
    await redis.del(key); // single-use
    return JSON.parse(raw) as AuthResponseDto;
  }

  private requireRedis(): NonNullable<typeof redisClient> {
    if (!redisClient) {
      throw new BadRequestError('SSO memerlukan Redis, yang belum dikonfigurasi di server ini.');
    }
    return redisClient;
  }

  private buildRedirectUri(tenantSlug: string): string {
    if (!env.APP_BASE_URL) {
      throw new BadRequestError('SSO belum dikonfigurasi di server ini (APP_BASE_URL kosong).');
    }
    return `${env.APP_BASE_URL}/api/v1/auth/sso/${tenantSlug}/callback`;
  }

  private async getActiveConnectionOrThrow(tenantSlug: string) {
    const tenant = await this.tenantRepository.findBySlug(tenantSlug);
    if (!tenant) {
      throw new NotFoundError('Tenant tidak ditemukan');
    }
    const connection = await this.ssoConnectionRepository.findByTenantId(tenant.id);
    if (!connection || !connection.enabled) {
      throw new BadRequestError('SSO belum dikonfigurasi/tidak aktif untuk tenant ini.');
    }
    return { tenant, connection };
  }

  private async buildOidcClient(
    connection: { issuerUrl: string; clientId: string; clientSecretEncrypted: string },
    redirectUri: string
  ): Promise<Client> {
    const clientSecret = encryptionService.decrypt(connection.clientSecretEncrypted);
    const issuer = await Issuer.discover(connection.issuerUrl);
    return new issuer.Client({
      client_id: connection.clientId,
      client_secret: clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code'],
    });
  }

  /**
   * Alur cari-atau-buat user — pola SENGAJA identik dengan
   * `OAuthService.findOrCreateUser` (lihat komentar lengkap di
   * sana), dengan SATU perbedaan kritis: kalau email sudah terdaftar
   * di tenant LAIN, di sini DITOLAK (bukan ditautkan) — SSO adalah
   * jalur masuk yang terikat identitas ORGANISASI (tenant), berbeda
   * dari OAuth konsumen (Google/GitHub) yang tidak punya konsep
   * tenant sama sekali.
   */
  private async findOrProvisionUser(
    tenantId: string,
    subject: string,
    email: string,
    name: string
  ): Promise<SsoUser> {
    const existingIdentity = await this.ssoIdentityRepository.findByTenantAndSubject(
      tenantId,
      subject
    );
    if (existingIdentity) {
      const user = await this.userRepository.findById(existingIdentity.userId);
      if (!user) {
        throw new UnauthorizedError('Akun tidak ditemukan');
      }
      return user;
    }

    let user = await this.userRepository.findByEmail(email);
    if (user && user.tenantId && user.tenantId !== tenantId) {
      throw new ForbiddenError(
        'Email ini sudah terdaftar di tenant lain — SSO tidak menautkan lintas-tenant.'
      );
    }

    if (!user) {
      user = await this.userRepository.create({
        email,
        name,
        password: null,
        emailVerifiedAt: new Date(),
      });
    }

    await this.ssoIdentityRepository.create({ tenantId, subject, userId: user.id });
    return user;
  }
}
