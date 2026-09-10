{{/*
Label umum — dipakai SEMUA template di bawah, supaya `kubectl get all
-l app.kubernetes.io/name=backend-foundation` konsisten menemukan
seluruh resource chart ini, terlepas dari komponennya.
*/}}
{{- define "backend-foundation.labels" -}}
app.kubernetes.io/name: backend-foundation
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}
