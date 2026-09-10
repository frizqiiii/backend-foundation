provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kube_context
  }
}

resource "kubernetes_namespace" "backend_foundation" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/name"       = "backend-foundation"
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

# Phase 20 (Auto Migration/Rollback Strategy lewat Terraform) —
# `helm_release` DENGAN chart LOKAL (`var.chart_path`), BUKAN
# `kubectl apply` manifest mentah satu-satu — supaya `terraform
# destroy`/`terraform apply` dengan values baru otomatis memicu
# lifecycle Helm yang SAMA (termasuk migration hook di
# `templates/migration-job.yaml`) seperti kalau dijalankan manual
# lewat `helm upgrade`. Rollback dari sisi Terraform berarti
# `terraform apply` dengan `var.image_tag` versi sebelumnya — Helm
# sendiri yang menangani rolling update-nya (lihat
# `helm/backend-foundation/templates/deployment.yaml`).
resource "helm_release" "backend_foundation" {
  name       = var.release_name
  namespace  = kubernetes_namespace.backend_foundation.metadata[0].name
  chart      = var.chart_path
  # `wait: true` — `terraform apply` TIDAK dianggap selesai sampai
  # SELURUH Pod Deployment API/worker Ready (termasuk menunggu
  # migration hook selesai lebih dulu, karena hook Helm secara
  # definisi berjalan sebelum resource lain dianggap "deployed") —
  # kegagalan rollout langsung membuat `terraform apply` gagal juga,
  # bukan terlihat "sukses" padahal Pod di cluster CrashLoopBackOff.
  wait          = true
  wait_for_jobs = true
  timeout       = 300

  set {
    name  = "image.repository"
    value = var.image_repository
  }
  set {
    name  = "image.tag"
    value = var.image_tag
  }
  set {
    name  = "api.replicas"
    value = var.api_replicas
  }
  set {
    name  = "worker.replicas"
    value = var.worker_replicas
  }
  set {
    name  = "ingress.host"
    value = var.ingress_host
  }
  set {
    name  = "hpa.enabled"
    value = var.hpa_enabled
  }
  set {
    name  = "hpa.minReplicas"
    value = var.hpa_min_replicas
  }
  set {
    name  = "hpa.maxReplicas"
    value = var.hpa_max_replicas
  }

  set_sensitive {
    name  = "secrets.DATABASE_URL"
    value = var.database_url
  }
  set_sensitive {
    name  = "secrets.REDIS_URL"
    value = var.redis_url
  }
  set_sensitive {
    name  = "secrets.JWT_SECRET"
    value = var.jwt_secret
  }
  set_sensitive {
    name  = "secrets.ENCRYPTION_KEY"
    value = var.encryption_key
  }

  dynamic "set_sensitive" {
    for_each = var.additional_secrets
    content {
      name  = "secrets.${set_sensitive.key}"
      value = set_sensitive.value
    }
  }
}
