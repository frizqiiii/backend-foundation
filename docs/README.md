# Dokumentasi — backend-foundation

Indeks dokumentasi teknis proyek ini (Phase 21 — Enterprise
Documentation audit). Setiap dokumen berdiri sendiri — tidak perlu
dibaca berurutan, langsung ke yang relevan dengan kebutuhan Anda.

| Dokumen | Isi |
|---|---|
| [architecture.md](./architecture.md) | Gambaran arsitektur modular monolith, alasan tiap keputusan struktural |
| [erd.md](./erd.md) | Entity-Relationship Diagram seluruh 19 model database |
| [sequence-diagrams.md](./sequence-diagrams.md) | Alur Authentication, Authorization, Session Revocation, dan Export Asynchronous |
| [deployment-diagram.md](./deployment-diagram.md) | **Baru (Phase 21)** — topologi deploy VPS+PM2 dan Kubernetes berdampingan |
| [infrastructure-diagram.md](./infrastructure-diagram.md) | **Baru (Phase 21)** — topologi dependency eksternal, klasifikasi wajib/opsional |
| [security-guide.md](./security-guide.md) | Ringkasan seluruh lapisan keamanan yang sudah diimplementasikan |
| [monitoring-guide.md](./monitoring-guide.md) | Prometheus, Grafana, Alertmanager, dan metric queue (Bull Board) + Monitoring Diagram |
| [observability-guide.md](./observability-guide.md) | Distributed tracing (OpenTelemetry), correlation ID, log-trace correlation + Tracing Diagram |
| [runbook.md](./runbook.md) | **Baru (Phase 21)** — prosedur operasional: deploy, rollback, scale, restart worker, rotasi secret |
| [incident-response-guide.md](./incident-response-guide.md) | **Baru (Phase 21)** — klasifikasi severity, playbook per skenario, template post-mortem |
| [disaster-recovery-guide.md](./disaster-recovery-guide.md) | **Baru (Phase 21)** — RTO/RPO, skenario kehilangan infrastruktur total |
| [backup-restore-guide.md](./backup-restore-guide.md) | Prosedur teknis backup & restore database |
| [developer-guide.md](./developer-guide.md) | Onboarding: setup lokal, konvensi kode, cara menambah modul baru |
| [tenant-migration-strategy.md](./tenant-migration-strategy.md) | Strategi migrasi bertahap ke multi-tenancy |
| [scalability-guide.md](./scalability-guide.md) | Pertimbangan scaling horizontal, connection pool |
| [slo.md](./slo.md) | Definisi SLO/error budget |
| [owasp-asvs-checklist.md](./owasp-asvs-checklist.md) | Checklist kepatuhan OWASP ASVS |
| [integrations-guide.md](./integrations-guide.md) | Provider eksternal (email/SMS/push/payment/storage/search) |
| [../MUTATION_TESTING.md](../MUTATION_TESTING.md) | **Baru (Phase 21)** — scope & cara pakai mutation testing (Stryker) |
| [../k8s/README.md](../k8s/README.md) | Strategi Blue-Green/Canary/Rollback Kubernetes (Phase 20) |
| [../terraform/README.md](../terraform/README.md) | Scope & asumsi Terraform (Phase 20) |
| [../performance-tests/README.md](../performance-tests/README.md) | Load/Stress/Spike/Soak Test, Performance Benchmark (Phase 12 + 21) |
| [../deploy/README.md](../deploy/README.md) | **Deployment Guide VPS** — sumber kebenaran setup awal server (tidak diduplikasi di sini) |

## Cara Membaca Diagram

Diagram di dokumentasi ini memakai sintaks [Mermaid](https://mermaid.js.org/)
— dirender otomatis oleh GitHub, GitLab, dan sebagian besar editor Markdown
modern (mis. VS Code dengan ekstensi Markdown Preview Mermaid). Kalau
software Anda tidak mendukungnya, salin blok kode ke <https://mermaid.live>
untuk melihat hasil visualnya.

## Audit Phase 21 — Perbaikan Dokumen Basi

Tiga bug dokumentasi ditemukan & diperbaiki saat audit ini (dicatat
di sini untuk transparansi, bukan disembunyikan lewat "silent fix"):

1. `erd.md` menyebut field `User.passwordHash` — field sungguhan di
   schema adalah `User.password`. Diperbaiki, plus 7 model yang
   belum tercatat (`Tenant`, `MfaRecoveryCode`, `ApiKey`,
   `WebhookEndpoint`, `FeatureFlag`, `SearchDocument`, `ExportJob`)
   ditambahkan.
2. `observability-guide.md` menyebut Prisma dan BullMQ "belum
   ter-instrument" sebagai keterbatasan — sudah tidak akurat sejak
   Phase 16 (keduanya sudah ter-instrument). Diperbaiki.
3. `monitoring-guide.md` menyebut Alertmanager "belum dikonfigurasi"
   — kontradiksi langsung dengan `observability-guide.md` yang
   mendokumentasikan Alertmanager lengkap. Diperbaiki (dan
   `/health` vs `/ready` diperjelas mengikuti pemisahan Phase 18).

Satu gap OPERASIONAL nyata juga ditemukan dan diperbaiki di luar
folder ini: `deploy/scripts/deploy.sh` memakai `/health` (liveness)
sebagai gate rollback otomatis pasca-deploy — sejak `/health` dan
`/ready` dipisah di Phase 18, ini berarti rollback TIDAK akan
terpicu kalau deploy merusak koneksi database/Redis tapi proses
Node-nya sendiri tetap hidup. Default diganti ke `/ready`.
