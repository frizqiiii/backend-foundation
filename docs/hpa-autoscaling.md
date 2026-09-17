# HPA / Autoscaling (Kelompok 2, item 2.9)

## Batasan jujur

HPA (`HorizontalPodAutoscaler`) murni fitur Kubernetes — perilakunya
dikendalikan `metrics-server` + controller manager sungguhan,
TIDAK BISA disimulasikan tanpa cluster k8s nyata. Sandbox AI ini
tidak bisa menjalankan cluster k8s sama sekali (semua distro ringan —
`kind`/`k3d`/`minikube --driver=docker` — butuh Docker menarik image
dari registry yang tidak terjangkau dari sandbox ini). Ini beda dari
item Vault sebelumnya (yang bisa diinstall sebagai binary tunggal) —
cluster k8s adalah permintaan infrastruktur yang jauh lebih besar.

Yang BISA dan SUDAH saya lakukan: **audit statis mendalam** terhadap
`k8s/hpa.yaml` + `k8s/deployment.yaml` — memeriksa prasyarat yang
kalau salah akan membuat HPA gagal total tanpa error yang jelas.

## Hasil audit statis — TIDAK ADA bug ditemukan (manifest sudah matang)

Diperiksa 3 prasyarat KRITIS yang paling sering jadi penyebab "HPA
terpasang tapi tidak pernah scale" di dunia nyata:

1. **`resources.requests` HARUS ada di container** — HPA menghitung
   utilization % relatif terhadap `requests`, BUKAN `limits`. Tanpa
   `requests`, HPA tidak bisa menghitung apa pun (metric `<unknown>`
   selamanya). **Sudah benar** — `k8s/deployment.yaml` punya
   `requests: { cpu: 250m, memory: 256Mi }`.
2. **`readinessProbe` harus ada** — tanpa ini, Pod baru hasil
   scale-up langsung menerima traffic SEBELUM benar-benar siap
   (aplikasi masih connect ke DB/Redis dst), bikin scale-up
   memperburuk keadaan alih-alih membantu. **Sudah benar** — `/ready`
   dengan `initialDelaySeconds: 5`.
3. **`scaleTargetRef.name` harus PERSIS cocok dengan nama Deployment**
   — kalau typo, HPA silently tidak menemukan target-nya.
   **Sudah benar** — `backend-foundation-api` cocok di kedua file.

`behavior.scaleUp`/`scaleDown` juga sudah didesain dengan pertimbangan
matang (scale-up instan, scale-down lambat 5 menit untuk mencegah
flapping) — sudah dijelaskan di komentar file itu sendiri, dikonfirmasi
masuk akal saat audit.

## Verifikasi nyata — OPSIONAL, butuh kamu jalankan sendiri

Kalau mau menutup celah ini 100% (bukan wajib — sama seperti bagian
`git pull`/`prisma` di blue-green kemarin yang juga belum diverifikasi
end-to-end), berikut cara paling realistis di Windows TANPA Docker
Desktop (sesuai environment kamu):

**Prasyarat**: `minikube` dengan driver **Hyper-V** (butuh Windows
Pro/Enterprise/Education — Hyper-V tidak tersedia di Windows Home;
cek dulu `systeminfo | findstr Hyper-V` atau coba
`Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V`
di PowerShell Administrator). Ini TIDAK butuh Docker Desktop sama
sekali — minikube dengan driver ini menjalankan VM sendiri.

```cmd
minikube start --driver=hyperv
minikube addons enable metrics-server

:: Image sudah ADA dan PUBLIK di GHCR sejak item 2.5 -- tidak perlu build lokal!
kubectl set image deployment/backend-foundation-api api=ghcr.io/frizqiiii/backend-foundation:<sha-terbaru> --dry-run=client -o yaml > /tmp/deploy-test.yaml
:: (atau edit k8s/deployment.yaml langsung, ganti `image:` ke image GHCR itu)

kubectl apply -f k8s/configmap.yaml -f k8s/secret.yaml -f k8s/deployment.yaml -f k8s/service.yaml -f k8s/hpa.yaml
kubectl wait --for=condition=available deployment/backend-foundation-api --timeout=120s

:: Di terminal LAIN, pantau HPA & replika secara live:
kubectl get hpa backend-foundation-api --watch
kubectl get pods --watch

:: Generate beban CPU nyata (pakai k6 yang sudah ada di project ini,
:: /health SENGAJA tidak menyentuh DB -- murni CPU/event-loop):
kubectl port-forward svc/backend-foundation-api 8080:80
k6 run --vus 200 --duration 5m performance-tests/stress-test.js
```

**Yang diharapkan terlihat** (kalau manifest bekerja seperti
didesain): `kubectl get hpa --watch` menunjukkan kolom `TARGETS`
(CPU%) naik melewati 70%, `REPLICAS` naik dari 3 menuju maksimal 10
dalam hitungan puluhan detik (scale-up `stabilizationWindowSeconds: 0`),
lalu setelah beban `k6` selesai, replika turun kembali PELAN-PELAN
(scale-down `stabilizationWindowSeconds: 300` — tunggu ~5 menit
sebelum turun, jangan salah kira ini "macet").

Kabari saya hasilnya (screenshot `kubectl get hpa --watch` cukup) —
kalau ada perilaku yang tidak sesuai ekspektasi di atas, itu jadi
bukti nyata pertama untuk debugging manifest ini, sesuai prinsip kerja
kita (jangan asumsi, verifikasi).
