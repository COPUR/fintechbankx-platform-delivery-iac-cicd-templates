{{- /*
Adapter: map this chart's value names onto the ones fbx.guard reads. Every
template that renders a workload calls it as its first action
(scripts/ci/verify-vendored-guard.sh, check (c)).
*/ -}}
{{- define "vendored-guard-example.guard" -}}
{{- include "fbx.guard" (dict "Values" (dict
      "config" .Values.env
      "extraEnv" .Values.additionalEnv
      "extraEnvFrom" .Values.additionalEnvFrom
      "javaToolOptions" .Values.jvmOptions
      "databaseCa" .Values.databaseCaBundle
      "kafka" (dict "runtime" .Values.kafkaRuntime)
      "externalSecret" (dict "enabled" .Values.secrets.enabled "data" .Values.secrets.keys
        "dataFrom" .Values.secrets.dataFrom))) -}}
{{- end -}}
