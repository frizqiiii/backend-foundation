# Incident Response Guide

## Klasifikasi Severity

| Level | Kriteria | Target respons awal |
|---|---|---|
| **SEV1** | Total outage (API tidak bisa diakses SAMA SEKALI), kebocoran data, atau kompromi keamanan aktif | Segera, drop semua pekerjaan lain |
| **SEV2** | Fitur inti terganggu (auth/payment/data gagal untuk sebagian besar user), tapi sistem masih sebagian berfungsi | < 30 menit |
| **SEV3** | Fitur non-inti terganggu (mis. export/notifikasi gagal, provider eksternal down) — ada workaround/degradasi graceful | < 4 jam kerja |
| **SEV4** | Bug kosmetik, isu performa minor, tidak ada dampak user langsung | Jadwal normal (backlog) |

Klasifikasi awal BOLEH salah — turunkan/naikkan severity begitu
dampak sesungguhnya lebih jelas, jangan menunggu kepastian penuh
sebelum mulai merespons SEV1/SEV2.

## Langkah Umum (berlaku semua severity)

1. **Ack** — konfirmasi Anda menangani (cegah dua orang investigasi
   buta tanpa koordinasi).
2. **Assess** — jalankan urutan cek cepat di `docs/runbook.md` §
   "Cek Kesehatan Sistem" SEBELUM asumsi penyebabnya.
3. **Mitigate dulu, root-cause belakangan** — untuk SEV1/SEV2,
   prioritas PERTAMA adalah mengembalikan layanan (rollback,
   restart, failover), BUKAN memahami akar masalah sepenuhnya.
   Investigasi mendalam bisa menunggu setelah user tidak lagi
   terdampak.
4. **Komunikasi** — update status ke channel insiden setiap
   perubahan signifikan, walau isinya "masih investigasi, belum ada
   temuan baru" — diam lebih lama dari 15-30 menit di SEV1/SEV2
   menimbulkan asumsi liar dari pihak yang menunggu.
5. **Post-mortem** (SEV1/SEV2 WAJIB, SEV3 disarankan) — lihat
   template di bawah, blameless (fokus ke sistem/proses, bukan
   individu).

## Playbook per Skenario

### API Down Total (SEV1)

1. `GET /health` dari luar (bukan dari server yang sama) — timeout
   atau connection refused?
2. Cek proses: `pm2 status` (VPS) / `kubectl get pods` (k8s) — proses
   crash-looping?
3. Cek log 50 baris terakhir SEBELUM crash — error yang jelas (mis.
   `DATABASE_URL` salah setelah deploy) vs OOM (`kubectl describe pod`,
   cari `OOMKilled`).
4. **Kalau baru saja deploy** → `docs/runbook.md` § Rollback, JANGAN
   debug dulu di production yang masih down.
5. **Kalau bukan dari deploy** (mis. VPS reboot, disk penuh) →
   `df -h` (disk), `free -h` (memori), restart proses kalau resource
   sudah tersedia lagi.

### Database Unreachable (SEV1)

1. `GET /ready` — konfirmasi `checks.database.status != "ok"`.
2. Cek proses Postgres langsung: `docker ps`/`kubectl get pods -n
   <namespace-db>` — container/pod database itu sendiri mati?
3. Kalau database HIDUP tapi API tidak bisa connect: cek
   `DATABASE_CONNECTION_LIMIT` (Phase 18 — `env.ts`) vs
   `max_connections` Postgres — replica API yang baru di-scale up
   tanpa menyesuaikan angka ini bisa menghabiskan connection pool
   (lihat rationale di `env.ts`).
4. Database corrupt/hilang → **eskalasi ke Disaster Recovery**, lihat
   `docs/disaster-recovery-guide.md`.

### Redis Down (SEV2 — bukan SEV1, sistem didesain tetap jalan tanpanya)

Dampak: cache miss (lebih lambat, tidak error), queue berhenti
(email/notifikasi/webhook/export fallback ke pemrosesan SINKRON,
lihat `shared/queue/*.ts`), rate limiter fallback ke in-memory
per-instance (proteksi melemah tapi tidak hilang total), distributed
lock (Phase 14) tidak berfungsi — request yang butuh idempotency
key/dedup (Phase 18) TIDAK lagi ter-dedup.

1. Konfirmasi lewat `GET /ready` (`checks.redis.status`).
2. Restart Redis / cek disk (Redis persistence bisa penuh disk kalau
   `maxmemory`/eviction policy tidak diset).
3. Prioritas RENDAH untuk buru-buru — sistem tetap melayani traffic
   inti selama Redis down, tapi JANGAN dibiarkan lama (fallback sinkron
   lebih lambat & lebih berat untuk proses API).

### Error Rate Melonjak / Latency Tinggi (SEV2/SEV3 tergantung skala)

1. Dashboard Grafana "SLO/Service Health" — burn rate error budget
   berapa? (lihat `docs/slo.md`)
2. Alert `LatencyP95AboveSLO`/`ErrorBudgetBurnFast` sudah firing di
   Alertmanager? Cek payload alert untuk endpoint spesifik yang
   bermasalah.
3. Cek apakah bersamaan dengan circuit breaker terbuka (Phase 18) —
   `grep "CircuitBreaker.*terbuka" log` — kalau ya, provider eksternal
   yang jadi akar masalah, BUKAN aplikasi ini (lihat playbook
   "Provider Eksternal Down" di bawah).
4. Bukan circuit breaker → cek `docker stats`/`kubectl top pod` —
   resource exhaustion (CPU/memori)? Kalau ya, scale up sementara
   (`docs/runbook.md` § Scale) sambil investigasi akar masalah.

### Provider Eksternal Down (Resend/Twilio/FCM/Stripe/S3) — SEV3

Circuit breaker (Phase 18) SEHARUSNYA sudah membatasi dampak secara
otomatis (request gagal cepat, tidak menumpuk menunggu timeout).
1. Konfirmasi lewat log: `CircuitBreaker '<key>': terbuka`.
2. Cek status page provider terkait (Resend/Twilio/dst punya status
   page publik).
3. TIDAK PERLU aksi manual — breaker otomatis mencoba pulih
   (`resetTimeoutMs`, lihat `shared/reliability/policies.ts`) begitu
   provider kembali normal. Job yang gagal selama outage ada di
   `dead-letter` queue (email/webhook) atau `ExportJob.status=FAILED`
   (export) — retry manual setelah provider pulih (`docs/runbook.md`
   § Dead Letter Queue).

### Dugaan Kebocoran Data / Kompromi Keamanan (SEV1)

1. **Jangan panik-hapus log/data** — bukti forensik dibutuhkan untuk
   investigasi.
2. Cabut akses yang dicurigai SEGERA: `DELETE /auth/sessions` untuk
   akun terdampak (Phase 17), revoke API key terkait
   (`shared/modules/api-keys`).
3. Kalau dicurigai `JWT_SECRET`/`ENCRYPTION_KEY` bocor → rotasi
   DARURAT (`docs/runbook.md` § Rotasi Secret) — dalam kasus ini
   LEWATI fase dua-tahap yang biasa (tidak apa-apa memutus sesi aktif
   semua user demi keamanan).
4. Cek `AuditLog`/`ActivityLog` untuk pola akses anomali di sekitar
   waktu insiden diduga terjadi.
5. Eskalasi ke pemilik sistem/tim keamanan — SEV1 keamanan biasanya
   punya kewajiban notifikasi eksternal (regulasi/kontrak) di luar
   cakupan runbook teknis ini.

## Template Post-Mortem

```markdown
# Post-Mortem: <judul singkat>

**Tanggal**: <tanggal insiden>
**Severity**: SEV<N>
**Durasi dampak**: <mulai> - <selesai> (<total durasi>)

## Ringkasan
<2-3 kalimat: apa yang terjadi, siapa/apa yang terdampak>

## Timeline
- HH:MM — <kejadian/tindakan>
- HH:MM — <kejadian/tindakan>

## Akar Masalah
<technical root cause, bukan "human error" sebagai jawaban akhir —
gali kenapa proses/sistem memungkinkan error itu terjadi>

## Dampak
<jumlah user terdampak, data yang hilang/rusak (jika ada), estimasi kerugian>

## Yang Berjalan Baik
<apa yang membantu mempercepat deteksi/pemulihan>

## Action Items
| Aksi | PIC | Deadline |
|---|---|---|
| | | |
```
