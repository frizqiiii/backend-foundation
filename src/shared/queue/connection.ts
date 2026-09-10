import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * Koneksi Redis KHUSUS BullMQ — SENGAJA terpisah dari `redisClient`
 * di `shared/config/redis.ts` (dipakai untuk cache). BullMQ
 * MEWAJIBKAN `maxRetriesPerRequest: null` pada koneksinya (supaya
 * BullMQ bisa mengatur ulang perilaku retry/blocking command sendiri
 * secara internal) — bertentangan langsung dengan kebutuhan cache
 * yang sengaja MEMBATASI retry (2x) supaya request HTTP tidak
 * menunggu lama saat Redis lambat/down. Dua kebutuhan yang berbeda,
 * dua koneksi yang berbeda.
 *
 * `null` kalau `REDIS_URL` tidak dikonfigurasi — konsisten dengan
 * pola opsional yang sama seperti cache: message queue TIDAK WAJIB
 * untuk aplikasi bisa berjalan; tanpa Redis, job dijalankan langsung
 * secara sinkron (lihat `email.queue.ts`/`notification.queue.ts`),
 * bukan lewat antrian sungguhan.
 *
 * Phase 14 (Enterprise Scalability) — koneksi ini SENGAJA TIDAK ikut
 * memakai mode Redis Cluster (`REDIS_CLUSTER_NODES`, lihat
 * `shared/config/redis.ts`) meski cache client sudah mendukungnya.
 * BullMQ menyimpan state satu queue (jobs, lock, delayed set, dst)
 * lewat Lua script yang mengakses BANYAK key sekaligus dalam satu
 * operasi atomik — di Redis Cluster, key-key itu HARUS berada di hash
 * slot yang SAMA (lewat hash tag) supaya scriptnya tetap valid, yang
 * berarti satu queue pada praktiknya tetap terikat ke SATU node/slot,
 * bukan benar-benar terdistribusi. BullMQ sendiri merekomendasikan
 * Redis standalone atau Sentinel (bukan Cluster) untuk kasus
 * penggunaan umum. Skalabilitas queue di proyek ini dicapai lewat
 * `concurrency`/rate limiting per worker (lihat `email.worker.ts`) dan
 * menjalankan LEBIH BANYAK proses worker (horizontal), bukan
 * men-cluster Redis-nya.
 */
export const queueConnection: Redis | null = env.REDIS_URL
  ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  : null;
