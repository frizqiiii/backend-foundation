# Runbook

Prosedur operasional untuk tugas rutin dan situasi umum. Untuk
insiden yang butuh eskalasi/klasifikasi severity, lihat
`docs/incident-response-guide.md`. Untuk kehilangan data/infrastruktur
total, lihat `docs/disaster-recovery-guide.md`.

## Deploy

**VPS**: otomatis lewat `git push` ke `main` (`.github/workflows/deploy.yml`
→ `deploy/scripts/deploy.sh`). Manual: SSH ke VPS, `./deploy/scripts/deploy.sh`.

**Kubernetes**: `helm upgrade backend-foundation ./helm/backend-foundation -f values-production.yaml`.
Lihat `k8s/README.md` untuk blue-green/canary.

## Rollback

**VPS**:
```bash
./deploy/scripts/rollback.sh
```
Otomatis terpicu kalau health check pasca-deploy gagal (mengecek
`/ready`, lihat Phase 21 audit di `deploy/scripts/deploy.sh`). Manual
kapan saja dengan perintah yang sama.

**Kubernetes**:
```bash
kubectl rollout undo deployment/backend-foundation-api
# atau
helm rollback backend-foundation
```

**PENTING (berlaku kedua jalur)**: rollback KODE tidak mengembalikan
migrasi database yang sudah jalan. Kalau migration BARU yang
menyebabkan masalah, restore data perlu langkah TERPISAH — lihat
`docs/backup-restore-guide.md`.

## Scale

**VPS**: edit `deploy/pm2/ecosystem.config.js` (`instances`), lalu
`pm2 reload ecosystem.config.js`.

**Kubernetes**:
```bash
kubectl scale deployment/backend-foundation-api --replicas=5
# atau permanen: edit values.yaml -> api.replicas, helm upgrade
```
HPA (`k8s/hpa.yaml`) sudah menangani scale otomatis 3-10 replika
berdasar CPU/memori — scale manual di atas untuk situasi di luar
jangkauan HPA (mis. event terjadwal dengan lonjakan traffic yang
diketahui sebelumnya, scale up preventif).

## Restart Worker (queue macet/worker hang)

```bash
# VPS
pm2 restart worker

# Kubernetes
kubectl rollout restart deployment/backend-foundation-worker
```

Cek dulu APAKAH worker benar-benar macet sebelum restart (restart
membatalkan job yang sedang diproses, akan di-retry BullMQ tapi tetap
menunda): buka Bull Board (`/admin/queues`, kredensial
`QUEUE_DASHBOARD_USER`/`PASSWORD`) — kalau ada job "active" yang
`processedOn`-nya sudah lama tanpa progress, itu tanda macet.

## Job Menumpuk di Dead Letter Queue

1. Buka Bull Board (`/admin/queues`) → queue `dead-letter`.
2. Inspeksi `failedReason` tiap job — pola yang sama di banyak job
   biasanya menandakan bug sistemik (mis. provider eksternal down
   lama, lihat status circuit breaker lewat log `CircuitBreaker
   '<key>': terbuka` di Pino), bukan kegagalan acak.
3. Setelah akar masalah diperbaiki, job BISA di-retry manual lewat
   Bull Board (tombol "Retry" per job) — TIDAK ada mekanisme
   re-queue massal otomatis (sengaja, supaya operator meninjau dulu
   sebelum membanjiri ulang sistem yang baru pulih).

## Rotasi Secret (JWT_SECRET / ENCRYPTION_KEY)

Lihat proses rotasi lengkap (dua-fase, tanpa downtime) di komentar
`JWT_SECRET_PREVIOUS`/`ENCRYPTION_KEY_PREVIOUS` di
`src/shared/config/env.ts` — ringkasnya:
1. Isi `<VAR>_PREVIOUS` dengan value LAMA, `<VAR>` dengan value BARU.
2. Deploy — token/data lama tetap valid (diverifikasi terhadap
   `_PREVIOUS`), token/data BARU pakai key baru.
3. Setelah SELURUH token lama pasti sudah expired (lihat
   `JWT_EXPIRES_IN`/masa berlaku refresh token), kosongkan
   `<VAR>_PREVIOUS`, deploy lagi.

## Menaikkan/Menurunkan Rate Limit Darurat

Endpoint tertentu terlalu sering kena rate limit legitimate traffic,
atau sebaliknya sedang di-abuse:

```bash
# VPS — edit .env, lalu:
pm2 reload ecosystem.config.js

# Kubernetes — TIDAK perlu image baru, cukup values:
helm upgrade backend-foundation ./helm/backend-foundation --reuse-values \
  --set config.SOME_RATE_LIMIT_VAR=xxx
```
Lihat `shared/security/rate-limiter.ts` untuk konfigurasi
`generalRateLimiter` (per-IP) dan `tenantRateLimiter` (per-tenant,
Phase 18).

## Menyalakan/Mematikan Distributed Tracing di Production

```bash
OTEL_ENABLED=true   # butuh OTel Collector/Jaeger reachable, lihat docs/observability-guide.md
```
Aman dinyalakan/dimatikan kapan saja tanpa downtime (restart proses
biasa) — TIDAK ada migrasi data yang terlibat.

## Cek Kesehatan Sistem Sebelum Mulai Investigasi Manual

Urutan cek cepat (dari yang paling murah ke paling mahal):
1. `GET /health` — proses hidup?
2. `GET /ready` — dependency (DB/Redis/queue) terjangkau?
3. Dashboard Grafana "Overview" — request rate/error rate/latency anomali?
4. Dashboard Grafana "SLO/Service Health" — error budget masih tersisa?
5. Bull Board `/admin/queues` — job menumpuk di queue mana?
6. `docker logs`/`pm2 logs`/`kubectl logs` — error terbaru di log Pino,
   cari `trace_id` kalau ada untuk telusuri lewat Jaeger.
