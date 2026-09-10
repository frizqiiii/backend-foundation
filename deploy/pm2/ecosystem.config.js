/**
 * PM2 ecosystem file — dijalankan lewat `pm2 start deploy/pm2/ecosystem.config.js`
 * dari root project (setelah `npm run build`, karena mengacu ke
 * `dist/*.js`, bukan source TypeScript).
 *
 * Dua proses didefinisikan TERPISAH (bukan satu proses menjalankan
 * keduanya) — konsisten dengan keputusan arsitektur di fase Message
 * Queue: beban pemrosesan job (email, notifikasi) tidak boleh
 * berbagi resource/proses dengan yang melayani HTTP request.
 */
module.exports = {
  apps: [
    {
      name: 'backend-foundation-api',
      script: 'dist/server.js',
      cwd: __dirname + '/../..',
      // Cluster mode + "max" — PM2 otomatis menjalankan satu instance
      // per core CPU yang tersedia, memakai Node.js `cluster` module
      // di baliknya untuk load balancing antar-instance. Cocok untuk
      // API server (stateless, tiap request independen).
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
      // Restart otomatis kalau proses memakai memori berlebihan
      // (indikasi memory leak) — pengaman tambahan di luar crash biasa.
      max_memory_restart: '500M',
      autorestart: true,
      // Batas restart bertubi-tubi dalam waktu singkat — mencegah
      // "restart loop" tak berkesudahan kalau konfigurasi/DB benar-benar
      // rusak (lebih baik proses berhenti & butuh intervensi manual,
      // daripada restart-crash tanpa henti membebani server).
      max_restarts: 10,
      min_uptime: '10s',
      out_file: 'logs/api-out.log',
      error_file: 'logs/api-error.log',
      time: true,
    },
    {
      name: 'backend-foundation-worker',
      script: 'dist/worker.js',
      cwd: __dirname + '/../..',
      // Fork mode (BUKAN cluster) — worker BullMQ mengelola konkurensi
      // job-nya sendiri secara internal; menjalankan banyak instance
      // cluster di sini hanya akan membuat beberapa proses berebut job
      // yang sama tanpa manfaat load-balancing seperti di HTTP server.
      // Untuk menambah kapasitas pemrosesan job, tambah `instances`
      // secara eksplisit (mis. 2-3) — BUKAN 'max'.
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '300M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      out_file: 'logs/worker-out.log',
      error_file: 'logs/worker-error.log',
      time: true,
    },
  ],
};
