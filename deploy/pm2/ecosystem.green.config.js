/**
 * Fase 2 (Kelompok 2, item 2.8 — Blue-Green Deployment) — INSTANCE
 * KEDUA ("green") untuk blue-green switch, TERPISAH dari
 * `ecosystem.config.js` utama (yang tetap merepresentasikan "blue").
 * SENGAJA file terpisah (bukan digabung ke `ecosystem.config.js`
 * sebagai app tambahan permanen) — konsisten dengan keputusan yang
 * sudah didokumentasikan di `deploy/README.md` § "Blue/Green
 * Deployment": mengaktifkan blue-green butuh KAPASITAS SERVER 2x
 * LIPAT selama masa transisi, keputusan operasional yang harus sadar
 * diambil operator, bukan otomatis berjalan tiap `pm2 start
 * ecosystem.config.js` biasa.
 *
 * Dipakai HANYA oleh `deploy/scripts/deploy-blue-green.sh` — jangan
 * jalankan `pm2 start` file ini manual di luar skrip itu kecuali
 * benar-benar tahu apa yang sedang dilakukan (lihat prosedur lengkap
 * di `docs/blue-green-deployment.md`).
 */
module.exports = {
  apps: [
    {
      name: 'backend-foundation-api-green',
      script: 'dist/server.js',
      cwd: __dirname + '/../..',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        // SATU-SATUNYA perbedaan berarti dari instance "blue" — port
        // terpisah supaya keduanya bisa berjalan BERSAMAAN di server
        // yang sama sebelum traffic di-switch.
        PORT: 3001,
      },
      max_memory_restart: '500M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      out_file: 'logs/api-green-out.log',
      error_file: 'logs/api-green-error.log',
      time: true,
    },
  ],
};
