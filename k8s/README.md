# Kubernetes Manifests — Phase 20 (Enterprise DevOps)

Jalur deployment **baru dan aditif** — TIDAK menggantikan pipeline VPS+PM2 yang sudah ada (`deploy/scripts/deploy.sh`, dipicu `.github/workflows/deploy.yml`). Kedua jalur boleh hidup berdampingan; pilih sesuai target infrastruktur Anda.

> **Cara pakai paling mudah: lewat Helm** (`../helm/backend-foundation`), bukan `kubectl apply` manifest mentah ini satu-satu. File di direktori ini tetap disediakan sebagai referensi/dipakai langsung untuk cluster kecil yang belum butuh Helm.

## Urutan apply manual (tanpa Helm)

```bash
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml   # ISI DULU value aslinya — lihat peringatan di dalam file
kubectl apply -f migration-job.yaml
kubectl wait --for=condition=complete job/backend-foundation-migrate --timeout=120s
kubectl delete -f migration-job.yaml
kubectl apply -f deployment.yaml
kubectl apply -f worker-deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f hpa.yaml
kubectl apply -f ingress.yaml
```

## Rollback Strategy

Tiga lapis, dari yang paling sering dipakai ke paling jarang:

1. **`kubectl rollout undo`** — bawaan Kubernetes, bekerja karena `deployment.yaml` memakai `strategy: RollingUpdate` dengan `revisionHistoryLimit: 5` (5 revisi terakhir disimpan).
   ```bash
   kubectl rollout undo deployment/backend-foundation-api
   kubectl rollout status deployment/backend-foundation-api   # tunggu sampai selesai
   ```
   Setara persis dengan `rollback.sh` di pipeline VPS — bedanya di sini bawaan platform, tidak perlu script.

2. **Blue-Green switch** (lihat bagian di bawah) — kalau masalah baru ketahuan SETELAH traffic 100% pindah, `service.yaml` tinggal diedit balik ke `track: stable` (Deployment lama, kalau belum dihapus) — pemulihan dalam hitungan detik, tanpa rolling update sama sekali.

3. **Rollback data** — SAMA seperti dicatat di `rollback.sh`: rollback kode (langkah 1-2) TIDAK mengembalikan skema/data database yang sudah ter-migrate. Kalau migration di `migration-job.yaml` yang jadi biang masalah, pemulihan data WAJIB manual dari backup (di luar cakupan manifest ini — pipeline VPS punya `backup-db.sh` terpisah; untuk k8s, pasang CronJob backup serupa atau pakai managed database dengan snapshot otomatis).

## Blue-Green Deployment

Mekanismenya: `service.yaml` memilih Pod HANYA lewat label `track` (lihat komentar di file itu).

```bash
# 1. Deploy versi baru sebagai "green" — BELUM menerima traffic sama sekali
kubectl apply -f deployment.yaml   # tapi dengan track: green + image tag baru, disimpan sebagai file terpisah mis. deployment-green.yaml
kubectl wait --for=condition=available deployment/backend-foundation-api-green --timeout=120s

# 2. Validasi manual/otomatis (smoke test langsung ke Pod green lewat port-forward, TANPA lewat Service)
kubectl port-forward deployment/backend-foundation-api-green 3001:3000
curl http://localhost:3001/health

# 3. Switch traffic — edit SATU baris di service.yaml: `track: stable` -> `track: green`
kubectl apply -f service.yaml

# 4. Setelah yakin stabil, hapus Deployment lama (yang sekarang "blue")
kubectl delete deployment backend-foundation-api-blue
```

Cutover di langkah 3 **atomik** — tidak ada rentang waktu traffic terbagi antara versi lama/baru (beda dari canary di bawah, yang justru SENGAJA membagi traffic).

## Canary Deployment

Lihat `ingress-canary.yaml` + `service-canary.yaml` — dua resource TERPISAH dari `ingress.yaml`/`service.yaml`, dipasangkan lewat anotasi `nginx.ingress.kubernetes.io/canary`.

```bash
kubectl apply -f service-canary.yaml   # Service + Deployment canary (track: canary, 1 replica)
kubectl apply -f ingress-canary.yaml   # canary-weight: 0 dulu — belum ada traffic nyasar ke sini

# Naikkan bertahap sambil memantau error rate/latency canary vs stable
kubectl annotate ingress backend-foundation-api-canary nginx.ingress.kubernetes.io/canary-weight="5" --overwrite
# ... tunggu, pantau metrics (Prometheus/Grafana, Phase 16) ...
kubectl annotate ingress backend-foundation-api-canary nginx.ingress.kubernetes.io/canary-weight="25" --overwrite
# ... dst sampai 100, ATAU turunkan ke 0/hapus canary kapan saja kalau ada gejala tidak sehat
```

Beda mendasar dari Blue-Green: canary MEMBAGI persentase traffic ke DUA versi SEKALIGUS untuk suatu periode (menguji versi baru dengan risiko/exposure terbatas), sedangkan blue-green memindahkan 100% traffic sekali jalan setelah divalidasi terpisah dari traffic produksi.

## Auto Migration

Lihat komentar lengkap di `migration-job.yaml` — Job terpisah (bukan init container), WAJIB `kubectl wait --for=condition=complete` sebelum melanjutkan ke `deployment.yaml` (atau otomatis lewat Helm hook, lihat `../helm/backend-foundation`).
