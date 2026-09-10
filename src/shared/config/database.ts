import { PrismaClient } from '@prisma/client';
import { env } from './env';

/**
 * Prisma Client sebagai singleton.
 * Menghindari pembuatan koneksi berulang (connection pool exhaustion),
 * khususnya saat hot-reload di mode development.
 */
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __prismaRead: PrismaClient | undefined;
}

/**
 * Menambahkan `connection_limit`/`pool_timeout` ke connection string
 * (Phase 14 — Connection Pool Optimization) — HANYA kalau env var
 * terkait diisi (lihat komentar lengkap di `env.ts`); kalau tidak,
 * connection string dikembalikan apa adanya dan Prisma memakai
 * default bawaannya sendiri.
 */
function withPoolParams(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (env.DATABASE_CONNECTION_LIMIT > 0) {
    url.searchParams.set('connection_limit', String(env.DATABASE_CONNECTION_LIMIT));
  }
  if (env.DATABASE_POOL_TIMEOUT_SECONDS > 0) {
    url.searchParams.set('pool_timeout', String(env.DATABASE_POOL_TIMEOUT_SECONDS));
  }
  return url.toString();
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    datasources: { db: { url: withPoolParams(env.DATABASE_URL) } },
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

/**
 * Client PostgreSQL read-replica (Phase 14) — lihat penjelasan
 * lengkap trade-off replication lag di komentar `DATABASE_REPLICA_URL`
 * (`env.ts`) sebelum memakai ini di Repository baru.
 *
 * FALLBACK KE PRIMARY kalau `DATABASE_REPLICA_URL` tidak dikonfigurasi
 * — `prismaRead` SELALU aman dipakai sebagai pengganti `prisma` untuk
 * query baca, di SEMUA environment, baik yang sudah maupun belum
 * punya replica sungguhan. Ini konsisten dengan pola
 * graceful-degradation yang sama di seluruh aplikasi (cache, Redis
 * Cluster, dst): fitur scalability tambahan tidak boleh jadi
 * prasyarat aplikasi bisa jalan.
 */
export const prismaRead: PrismaClient =
  global.__prismaRead ??
  (env.DATABASE_REPLICA_URL
    ? new PrismaClient({
        datasources: { db: { url: withPoolParams(env.DATABASE_REPLICA_URL) } },
        log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      })
    : prisma);

if (env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
  global.__prismaRead = prismaRead;
}
