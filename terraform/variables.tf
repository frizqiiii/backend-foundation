variable "kubeconfig_path" {
  description = "Path ke kubeconfig cluster TUJUAN — cluster itu sendiri diasumsikan SUDAH ADA (lihat README.md di direktori ini soal kenapa provisioning cluster di luar cakupan modul ini)."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "Context kubeconfig yang dipakai — WAJIB diisi eksplisit (bukan context aktif saat ini) supaya `terraform apply` tidak pernah secara tidak sengaja mengenai cluster yang salah hanya karena `kubectl config use-context` operator sedang menunjuk ke tempat lain."
  type        = string
}

variable "namespace" {
  description = "Namespace Kubernetes tempat seluruh resource chart ini dibuat."
  type        = string
  default     = "backend-foundation"
}

variable "release_name" {
  description = "Nama Helm release."
  type        = string
  default     = "backend-foundation"
}

variable "chart_path" {
  description = "Path lokal ke chart Helm (../helm/backend-foundation) — relatif dari direktori ini."
  type        = string
  default     = "../helm/backend-foundation"
}

variable "image_repository" {
  type    = string
  default = "backend-foundation"
}

variable "image_tag" {
  description = "Tag image yang di-deploy — WAJIB diisi eksplisit per environment/pipeline CI (JANGAN 'latest' untuk production sungguhan — 'latest' membuat `helm rollback` tidak benar-benar mengembalikan versi kode yang berjalan, hanya mengembalikan values Helm, sementara tag image-nya tetap sama)."
  type        = string
}

variable "api_replicas" {
  type    = number
  default = 3
}

variable "worker_replicas" {
  type    = number
  default = 2
}

variable "ingress_host" {
  type = string
}

variable "hpa_enabled" {
  type    = bool
  default = true
}

variable "hpa_min_replicas" {
  type    = number
  default = 3
}

variable "hpa_max_replicas" {
  type    = number
  default = 10
}

# --- Secrets (Phase 20) --------------------------------------------------
# SEMUA variable di bawah ini `sensitive = true` — Terraform akan
# MENYENSOR nilainya di `terraform plan`/`terraform apply` output
# (tampil sebagai `(sensitive value)`), TAPI TETAP tersimpan MENTAH
# di state file (`terraform.tfstate`) kecuali backend state dienkripsi
# (lihat README.md — WAJIB pakai remote backend terenkripsi, JANGAN
# pernah commit state file lokal ke Git). Untuk production sungguhan,
# pertimbangkan mengambil value ini dari Vault/AWS Secrets Manager
# lewat data source Terraform (`vault_generic_secret`,
# `aws_secretsmanager_secret_version`) alih-alih variable biasa —
# di luar cakupan modul ini karena tergantung secret manager mana
# yang dipakai organisasi Anda.
variable "database_url" {
  type      = string
  sensitive = true
}

variable "redis_url" {
  type      = string
  sensitive = true
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

variable "encryption_key" {
  type      = string
  sensitive = true
}

variable "additional_secrets" {
  description = "Field Secret tambahan (lihat daftar lengkap di k8s/secret.yaml) — mis. STRIPE_SECRET_KEY, TWILIO_AUTH_TOKEN, dst. Map kosong secara default supaya modul ini tetap bisa di-apply untuk environment yang belum butuh semua provider."
  type        = map(string)
  default     = {}
  sensitive   = true
}
