{{/* Workload name: serviceName, which is also the PLATFORM_CONTRACT <sa> name. */}}
{{- define "fbx.name" -}}
{{- required "serviceName is required (e.g. loan-lifecycle-service)" .Values.serviceName | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "fbx.serviceAccountName" -}}
{{- default (include "fbx.name" .) .Values.serviceAccount.name -}}
{{- end -}}

{{- define "fbx.secretName" -}}
{{- printf "%s-secrets" (include "fbx.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "fbx.version" -}}
{{- if .Values.image.tag -}}
{{- .Values.image.tag | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Chart.AppVersion -}}
{{- end -}}
{{- end -}}

{{/*
Selector labels. app.kubernetes.io/component=service keeps the Service, PDB,
NetworkPolicy and topology spread off the Flyway migration Job pods, which
carry the same app.kubernetes.io/name=<sa> (the mesh keys datastore egress on
it) with app.kubernetes.io/component=db-migration.
*/}}
{{- define "fbx.selectorLabels" -}}
app.kubernetes.io/name: {{ include "fbx.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: service
{{- end -}}

{{- define "fbx.labels" -}}
{{ include "fbx.selectorLabels" . }}
app.kubernetes.io/version: {{ include "fbx.version" . | quote }}
app.kubernetes.io/part-of: {{ printf "fintechbankx-%s" (required "boundedContext is required (e.g. lending)" .Values.boundedContext) }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
fintechbankx.io/service-id: {{ required "serviceId is required (e.g. svc-ln-loan-lifecycle)" .Values.serviceId }}
fintechbankx.io/context: {{ .Values.boundedContext }}
{{- end -}}

{{/* Pod labels: common labels plus the Istio canonical app/version labels. */}}
{{- define "fbx.podLabels" -}}
{{ include "fbx.labels" . }}
app: {{ include "fbx.name" . }}
version: {{ include "fbx.version" . | quote }}
{{- if .Values.istio.inject }}
sidecar.istio.io/inject: "true"
{{- end }}
{{- with .Values.podLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Image reference: digest wins; a mutable "latest" tag is rejected. */}}
{{- define "fbx.image" -}}
{{- $repo := required "image.repository is required" .Values.image.repository -}}
{{- if eq (lower (toString .Values.image.tag)) "latest" -}}
{{- fail "image.tag=latest is not allowed; use the git SHA tag or image.digest" -}}
{{- end -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repo .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (required "image.tag or image.digest is required" .Values.image.tag) -}}
{{- end -}}
{{- end -}}
