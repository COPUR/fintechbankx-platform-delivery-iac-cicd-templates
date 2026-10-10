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

{{/*
Every PostgreSQL JDBC URL the chart passes to the workload must verify the
server certificate and host name (sslmode=require encrypts but trusts any
certificate). The query string is parsed the way PgJDBC reads it (split after
the first '?', then on '&', key=value on the first '='), not searched for a
substring:
  - exactly one sslmode, equal to verify-full;
  - with databaseCa.enabled, exactly one sslrootcert, equal to
    <databaseCa.mountPath>/<databaseCa.key> (at most one otherwise);
  - no sslfactory / sslfactoryarg (NonValidatingFactory), sslhostnameverifier,
    sslpasswordcallback or service (pg_service.conf can override the TLS settings);
  - parameter names are plain [A-Za-z0-9_.-] (no percent-encoding), no
    percent-encoded '=' or '&' anywhere in the query, TLS keys in lower case
    (the driver ignores SSLMODE and would fall back to sslmode=prefer), and no
    TLS key before the '?'.
Checked values: every config value and every extraEnv value that starts with
jdbc:[<wrapper>:]postgresql: (case-insensitive).

Names (fbx.datasourceOverrideName; config keys, extraEnv names whether they use
value or valueFrom, and externalSecret.data / extraData secretKeys, which are
the env names the Secret materialises and whose values are never seen here):
  - (?i)^spring[._-]?(datasource|flyway|liquibase|r2dbc)[._-] (any Spring
    datasource, Flyway, Liquibase or R2DBC property, not only *URL), except
    SPRING_DATASOURCE_USERNAME and SPRING_DATASOURCE_PASSWORD;
  - spring.application.json in any spelling ([._-] or none, any case);
  - any name containing jdbc[._-]?url, sslfactory or sslhostnameverifier;
  - DB_URL outside config (config.DB_URL is the one allowed place);
  - (?i)^spring[._-]?config[._-]?(import|location|additional[._-]?location|name)$:
    an imported file or config tree, or another config file name in the
    image, can set spring.datasource.* where the chart never sees it. The chart renders no config import; a configtree, if
    a service ever needs one, must be rendered by the chart itself on the fixed
    mount optional:configtree:/etc/fintechbankx/config/ from a boolean value,
    never taken from a user-supplied value;
  - (?i)^spring[._-]?profiles[._-]?(active|include)$: a profile switches on an
    application-<profile>.yml inside the image. The chart renders no
    SPRING_PROFILES_ACTIVE, so no user-set profile name is allowed;
  - (?i)^fintechbankx[._-]?tls([._-]|$): fintechbankx.tls.enforce
    (FINTECHBANKX_TLS_ENFORCE) is the only switch that turns the service's
    startup TLS assertion off, and only the local profile and test resources
    set it; any other fintechbankx.tls.* key is refused with it.
The helper prints the reason (non-empty means rejected).
JVM options (JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS, _JAVA_OPTIONS and the chart's
javaToolOptions) can set -Dspring.datasource.url=..., -Djavax.net.ssl.*,
-Dspring.config.*, -Dspring.profiles.* or -Dfintechbankx.tls.*, or read more
options from a file: a value that mentions datasource, flyway, liquibase,
r2dbc, jdbc, ssl, application[._-]json, spring[._-]config, spring[._-]profiles
or fintechbankx[._-]tls, an option that
starts with '@' (argument file), -XX:VMOptionsFile or -XX:Flags
(case-insensitive) is rejected, and these names may not come from extraEnv
valueFrom or the ExternalSecret.
This closes the chart-side routes only; a profile or config file baked into
the image, and TLS on routes the chart does not see (the Kafka client, a
datasource built in code), are the service's own startup check (README,
"Service-side TLS assertion").
*/}}
{{- define "fbx.datasourceOverrideName" -}}
{{- $n := toString . -}}
{{- if regexMatch "(?i)^SPRING_DATASOURCE_(USERNAME|PASSWORD)$" $n -}}
{{- else if regexMatch "(?i)^spring[._-]?(datasource|flyway|liquibase|r2dbc)[._-]|^spring[._-]?application[._-]?json$|jdbc[._-]?url|sslfactory|sslhostnameverifier" $n -}}
it can redirect or override the datasource past the sslmode=verify-full check; set the JDBC URL in config.DB_URL
{{- else if regexMatch "(?i)^spring[._-]?config[._-]?(import|location|additional[._-]?location|name)$" $n -}}
a config import, location or name can load a file or config tree that overrides the datasource past the sslmode=verify-full check; the chart renders no config import
{{- else if regexMatch "(?i)^spring[._-]?profiles[._-]?(active|include)$" $n -}}
a profile can activate an application-<profile> config in the image whose datasource the chart cannot check; the chart sets no profile
{{- else if regexMatch "(?i)^fintechbankx[._-]?tls([._-]|$)" $n -}}
it can switch off the service's startup TLS assertion (fintechbankx.tls.enforce is for the local profile and tests only)
{{- end -}}
{{- end -}}

{{- define "fbx.isJvmOptionsName" -}}
{{- if regexMatch "(?i)^(JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$" (toString .) -}}true{{- end -}}
{{- end -}}

{{- define "fbx.validateJvmOptions" -}}
{{- if regexMatch "(?i)datasource|flyway|liquibase|r2dbc|jdbc|ssl|application[._-]?json|spring[._-]?config|spring[._-]?profiles|fintechbankx[._-]?tls|(^|\\s)@|-XX:(VMOptionsFile|Flags)" (toString .value) -}}
{{- fail (printf "%s must not mention datasource, flyway, liquibase, r2dbc, jdbc, ssl, application.json, spring.config, spring.profiles or fintechbankx.tls, nor read options from a file ('@' argument file, -XX:VMOptionsFile, -XX:Flags) (JVM system properties would override the datasource past the sslmode=verify-full check or switch off the service's TLS assertion)" .where) -}}
{{- end -}}
{{- end -}}

{{- define "fbx.validateDatabaseTls" -}}
{{- $root := . -}}
{{- include "fbx.validateJvmOptions" (dict "where" "javaToolOptions" "value" .Values.javaToolOptions) -}}
{{- range $name, $value := .Values.config -}}
{{- with include "fbx.datasourceOverrideName" $name -}}
{{- fail (printf "config.%s is not allowed: %s" $name .) -}}
{{- end -}}
{{- if include "fbx.isJvmOptionsName" $name -}}
{{- include "fbx.validateJvmOptions" (dict "where" (printf "config.%s" $name) "value" $value) -}}
{{- end -}}
{{- include "fbx.validateJdbcUrl" (dict "root" $root "where" (printf "config.%s" $name) "url" (toString $value)) -}}
{{- end -}}
{{- range $env := .Values.extraEnv -}}
{{- $envName := toString (default "" $env.name) -}}
{{- if eq (upper $envName) "DB_URL" -}}
{{- fail (printf "extraEnv must not set %s (value or valueFrom); set the JDBC URL in config.DB_URL, where sslmode=verify-full is enforced" $envName) -}}
{{- end -}}
{{- with include "fbx.datasourceOverrideName" $envName -}}
{{- fail (printf "extraEnv must not set %s (value or valueFrom): %s" $envName .) -}}
{{- end -}}
{{- if include "fbx.isJvmOptionsName" $envName -}}
{{- if not (hasKey $env "value") -}}
{{- fail (printf "extraEnv %s must set a literal value (valueFrom cannot be checked)" $envName) -}}
{{- end -}}
{{- include "fbx.validateJvmOptions" (dict "where" (printf "extraEnv.%s" $envName) "value" $env.value) -}}
{{- end -}}
{{- if hasKey $env "value" -}}
{{- include "fbx.validateJdbcUrl" (dict "root" $root "where" (printf "extraEnv.%s" $envName) "url" (toString $env.value)) -}}
{{- end -}}
{{- end -}}
{{- if .Values.externalSecret.enabled -}}
{{- range $field := list "data" "extraData" -}}
{{- range $entry := (index $root.Values.externalSecret $field | default list) -}}
{{- $key := toString (default "" $entry.secretKey) -}}
{{- if or (eq (upper $key) "DB_URL") (include "fbx.isJvmOptionsName" $key) -}}
{{- fail (printf "externalSecret.%s must not materialise %s; set the JDBC URL in config.DB_URL and JVM options in javaToolOptions, where they are checked (keep only the credentials in the secret)" $field $key) -}}
{{- end -}}
{{- with include "fbx.datasourceOverrideName" $key -}}
{{- fail (printf "externalSecret.%s must not materialise %s (keep only the credentials in the secret): %s" $field $key .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "fbx.validateJdbcUrl" -}}
{{- $where := .where -}}
{{- $url := trim .url -}}
{{- if regexMatch "(?i)^jdbc:(?:[a-z0-9-]+:)*postgresql:" $url -}}
{{- $ca := .root.Values.databaseCa -}}
{{- $want := printf "%s/%s" (trimSuffix "/" (toString $ca.mountPath)) (toString $ca.key) -}}
{{- $parts := regexSplit "\\?" $url 2 -}}
{{- $base := index $parts 0 -}}
{{- $query := "" -}}
{{- if eq (len $parts) 2 -}}{{- $query = index $parts 1 -}}{{- end -}}
{{- if regexMatch "(?i)ssl(mode|rootcert|factory|hostnameverifier)" $base -}}
{{- fail (printf "%s must carry TLS parameters only in the query string (after '?')" $where) -}}
{{- end -}}
{{- if regexMatch "(?i)%(3d|26)" $query -}}
{{- fail (printf "%s must not percent-encode '=' or '&' in the query string" $where) -}}
{{- end -}}
{{- $modes := list -}}
{{- $roots := list -}}
{{- range $param := splitList "&" $query -}}
{{- if $param -}}
{{- $kv := regexSplit "=" $param 2 -}}
{{- $key := index $kv 0 -}}
{{- $val := "" -}}
{{- if eq (len $kv) 2 -}}{{- $val = index $kv 1 -}}{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9_.-]+$" $key) -}}
{{- fail (printf "%s has a query parameter name that is not plain [A-Za-z0-9_.-] (percent-encoding is not allowed): %q" $where $key) -}}
{{- end -}}
{{- $lk := lower $key -}}
{{- if has $lk (list "sslfactory" "sslfactoryarg" "sslhostnameverifier" "sslpasswordcallback" "service") -}}
{{- fail (printf "%s must not set %s (it can bypass certificate or host name verification)" $where $lk) -}}
{{- end -}}
{{- if and (has $lk (list "sslmode" "sslrootcert")) (ne $key $lk) -}}
{{- fail (printf "%s must spell %s in lower case (PgJDBC ignores it otherwise)" $where $key) -}}
{{- end -}}
{{- if eq $key "sslmode" -}}{{- $modes = append $modes $val -}}{{- end -}}
{{- if eq $key "sslrootcert" -}}{{- $roots = append $roots $val -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if gt (len $modes) 1 -}}
{{- fail (printf "%s must set sslmode exactly once (found %d)" $where (len $modes)) -}}
{{- end -}}
{{- if or (eq (len $modes) 0) (ne (index (append $modes "") 0) "verify-full") -}}
{{- fail (printf "%s must use sslmode=verify-full (with sslrootcert=%s)" $where $want) -}}
{{- end -}}
{{- if $ca.enabled -}}
{{- if or (ne (len $roots) 1) (ne (index (append $roots "") 0) $want) -}}
{{- fail (printf "%s must set sslrootcert=%s exactly once (the databaseCa bundle)" $where $want) -}}
{{- end -}}
{{- else if gt (len $roots) 1 -}}
{{- fail (printf "%s must set sslrootcert at most once" $where) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Egress CIDR floor (networkPolicy.egressCidrs), on top of the schema pattern
(IPv4 /8-/32, IPv6 /32-/128). The README intent is "VPC or VPC endpoint
subnets", so:
  - IPv4: a prefix shorter than /16 only inside 10.0.0.0/8, 172.16.0.0/12,
    192.168.0.0/16 (RFC1918) or 100.64.0.0/10 (shared address space); any
    other range must be /16 or narrower (an AWS VPC CIDR block is /16 at most,
    so a VPC in public address space still fits);
  - IPv6: no range that overlaps the IPv4-mapped block ::ffff:0:0/96 (inside
    it, or containing it such as ::/80) or the NAT64 prefixes 64:ff9b::/96 and
    64:ff9b:1::/48, which would re-open IPv4 egress;
  - IPv6 width: a range broader than /48 only when it lies fully inside the
    unique local block fc00::/7 (the schema already stops at /32); public
    IPv6 must be /48 or narrower (an Amazon-provided VPC IPv6 block is /56,
    a subnet /64);
  - IPv6 text must parse (one '::' at most, 8 hextets, valid dotted tail).
Ranges are compared as bit strings: two prefixes overlap when their first
min(p, q) bits are equal.
*/}}
{{- define "fbx.validateEgressCidrs" -}}
{{- $hexBits := dict "0" "0000" "1" "0001" "2" "0010" "3" "0011" "4" "0100" "5" "0101" "6" "0110" "7" "0111" "8" "1000" "9" "1001" "a" "1010" "b" "1011" "c" "1100" "d" "1101" "e" "1110" "f" "1111" -}}
{{- $octet := "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])" -}}
{{- $dotted := printf "^%s(?:\\.%s){3}$" $octet $octet -}}
{{- range $i, $entry := (.Values.networkPolicy.egressCidrs | default list) -}}
{{- $cidr := toString $entry.cidr -}}
{{- $where := printf "networkPolicy.egressCidrs[%d].cidr %s" $i $cidr -}}
{{- $parts := regexSplit "/" $cidr 2 -}}
{{- $addr := lower (index $parts 0) -}}
{{- $prefix := atoi (index (append $parts "0") 1) -}}
{{- if contains ":" $addr -}}
{{- /* IPv6: expand to 128 bits */ -}}
{{- if contains "." $addr -}}
{{- $v4 := regexFind "[^:]*$" $addr -}}
{{- if not (regexMatch $dotted $v4) -}}
{{- fail (printf "%s is not a valid IPv6 CIDR (bad dotted IPv4 tail)" $where) -}}
{{- end -}}
{{- $o := splitList "." $v4 -}}
{{- $hex := printf "%x:%x" (add (mul (atoi (index $o 0)) 256) (atoi (index $o 1))) (add (mul (atoi (index $o 2)) 256) (atoi (index $o 3))) -}}
{{- $addr = printf "%s%s" (trimSuffix $v4 $addr) $hex -}}
{{- end -}}
{{- $groups := list -}}
{{- $doubles := len (regexFindAll "::" $addr -1) -}}
{{- if gt $doubles 1 -}}
{{- fail (printf "%s is not a valid IPv6 CIDR (more than one '::')" $where) -}}
{{- else if eq $doubles 1 -}}
{{- $halves := regexSplit "::" $addr 2 -}}
{{- $left := list -}}{{- if index $halves 0 -}}{{- $left = splitList ":" (index $halves 0) -}}{{- end -}}
{{- $right := list -}}{{- if index $halves 1 -}}{{- $right = splitList ":" (index $halves 1) -}}{{- end -}}
{{- $n := add (len $left) (len $right) -}}
{{- if gt $n 7 -}}
{{- fail (printf "%s is not a valid IPv6 CIDR (too many hextets)" $where) -}}
{{- end -}}
{{- $groups = $left -}}
{{- range until (int (sub 8 $n)) -}}{{- $groups = append $groups "0" -}}{{- end -}}
{{- $groups = concat $groups $right -}}
{{- else -}}
{{- $groups = splitList ":" $addr -}}
{{- end -}}
{{- if ne (len $groups) 8 -}}
{{- fail (printf "%s is not a valid IPv6 CIDR (need 8 hextets)" $where) -}}
{{- end -}}
{{- $bits := "" -}}
{{- range $g := $groups -}}
{{- if not (regexMatch "^[0-9a-f]{1,4}$" $g) -}}
{{- fail (printf "%s is not a valid IPv6 CIDR (bad hextet %q)" $where $g) -}}
{{- end -}}
{{- range $c := splitList "" (printf "%s%s" (repeat (int (sub 4 (len $g))) "0") $g) -}}
{{- $bits = printf "%s%s" $bits (get $hexBits $c) -}}
{{- end -}}
{{- end -}}
{{- $mapped := printf "%s%s" (repeat 80 "0") (repeat 16 "1") -}}
{{- $m := min $prefix 96 -}}
{{- if eq (trunc (int $m) $bits) (trunc (int $m) $mapped) -}}
{{- fail (printf "%s is IPv4-mapped IPv6 or overlaps ::ffff:0:0/96; list the IPv4 range instead" $where) -}}
{{- end -}}
{{- /* NAT64: 64:ff9b::/96 (RFC 6052) and 64:ff9b:1::/48 (RFC 8215) translate to any IPv4 address */ -}}
{{- $nat64 := "00000000011001001111111110011011" -}}
{{- range $r := list (list (printf "%s%s" $nat64 (repeat 64 "0")) 96 "64:ff9b::/96") (list (printf "%s%s" $nat64 "0000000000000001") 48 "64:ff9b:1::/48") -}}
{{- $k := int (min $prefix (index $r 1)) -}}
{{- if eq (trunc $k $bits) (trunc $k (index $r 0)) -}}
{{- fail (printf "%s overlaps the NAT64 prefix %s, which reaches any IPv4 address; list the IPv4 range instead" $where (index $r 2)) -}}
{{- end -}}
{{- end -}}
{{- /* width floor: a public IPv6 range is /48 or narrower; only ULA (fc00::/7) may be wider */ -}}
{{- if and (lt $prefix 48) (not (and (ge $prefix 7) (eq (trunc 7 $bits) "1111110"))) -}}
{{- fail (printf "%s is a public IPv6 range broader than /48; only ranges inside the unique local block fc00::/7 may be wider" $where) -}}
{{- end -}}
{{- else -}}
{{- /* IPv4 (shape already checked by values.schema.json) */ -}}
{{- $bits := "" -}}
{{- range $o := splitList "." $addr -}}{{- $bits = printf "%s%08b" $bits (atoi $o) -}}{{- end -}}
{{- if lt $prefix 16 -}}
{{- $inside := false -}}
{{- range $r := list (list "00001010" 8) (list "101011000001" 12) (list "0110010001" 10) -}}
{{- $q := index $r 1 -}}
{{- if and (ge $prefix $q) (eq (trunc $q $bits) (index $r 0)) -}}{{- $inside = true -}}{{- end -}}
{{- end -}}
{{- if not $inside -}}
{{- fail (printf "%s is a public IPv4 range broader than /16; only RFC1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and 100.64.0.0/10 may be wider" $where) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
