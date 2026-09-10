# Terraform — Phase 20 (Enterprise DevOps)

## Scope & asumsi (PENTING dibaca dulu)

Modul ini mengelola **Helm release** ke cluster Kubernetes yang **SUDAH ADA** — modul ini **TIDAK** membuat cluster Kubernetes itu sendiri (EKS/GKE/AKS/dst).

Alasannya: provisioning cluster sangat spesifik per cloud provider (jaringan VPC, IAM, node pool, dst berbeda total antara AWS/GCP/Azure/bare-metal) — menebak satu provider tertentu tanpa informasi dari Anda soal target infrastruktur akan menghasilkan Terraform yang salah asumsi dan justru menyesatkan. Modul ini murni lapisan **aplikasi** (Helm release + namespace + secret) yang bekerja di ATAS cluster mana pun yang sudah tersedia — sama seperti bagaimana `helm/backend-foundation` (chart) sendiri tidak peduli cluster-nya di provider mana.

Kalau Anda butuh Terraform untuk provisioning cluster juga, beri tahu target cloud-nya (AWS EKS / GCP GKE / Azure AKS / lainnya) dan saya lanjutkan modul terpisah untuk itu — pola umum: modul `cluster/` (VPC + node pool + IAM) yang outputnya (endpoint, kubeconfig) menjadi input modul `main.tf` di sini.

## Pemakaian

```bash
cd terraform
terraform init

terraform plan \
  -var="kube_context=my-cluster" \
  -var="image_tag=v1.5.0" \
  -var="ingress_host=api.example.com" \
  -var="database_url=postgresql://..." \
  -var="redis_url=redis://..." \
  -var="jwt_secret=..." \
  -var="encryption_key=..."

terraform apply <argumen sama seperti plan>
```

Lebih baik lagi, taruh value-value di atas (terutama yang sensitif) di `terraform.tfvars` yang **masuk `.gitignore`**, atau lewat environment variable `TF_VAR_database_url`, dst — supaya tidak muncul di shell history.

## State file — WAJIB remote backend terenkripsi

State file Terraform menyimpan SELURUH value sensitif (`database_url`, `jwt_secret`, dst) dalam bentuk **plaintext**, terlepas dari `sensitive = true` di `variables.tf` (yang HANYA menyembunyikan dari output CLI, bukan dari state file). **JANGAN PERNAH** memakai backend `local` (default) untuk environment production — pakai remote backend terenkripsi, contoh:

```hcl
terraform {
  backend "s3" {
    bucket         = "your-terraform-state-bucket"
    key            = "backend-foundation/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "terraform-locks" # state locking, cegah dua `terraform apply` bersamaan
  }
}
```
(atau `azurerm`/`gcs` backend, tergantung cloud Anda — tambahkan blok ini ke `versions.tf` sebelum `terraform init` pertama kali.)

## Rollback via Terraform

```bash
terraform apply -var="image_tag=v1.4.2" <var lain seperti biasa>   # versi SEBELUMNYA
```
Helm provider menjalankan `helm upgrade` dengan chart yang sama tapi `image.tag` berbeda — rolling update biasa (BUKAN blue-green/canary, itu tetap lewat `helm upgrade --set canary...`/edit Service manual, lihat `../k8s/README.md`).
