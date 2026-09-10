output "namespace" {
  value = kubernetes_namespace.backend_foundation.metadata[0].name
}

output "helm_release_status" {
  value = helm_release.backend_foundation.status
}

output "helm_release_revision" {
  description = "Nomor revisi Helm — dipakai untuk `helm rollback <release> <revision - 1>` kalau rollback manual dibutuhkan di luar `terraform apply` ulang."
  value       = helm_release.backend_foundation.version
}
