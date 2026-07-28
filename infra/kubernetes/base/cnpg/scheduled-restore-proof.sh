#!/usr/bin/env sh
set -eu

: "${R2_ENDPOINT:?R2_ENDPOINT is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${R2_PREFIX:?R2_PREFIX is required}"
: "${BARMAN_SERVER_NAME:?BARMAN_SERVER_NAME is required}"
: "${PG18_IMAGE:?PG18_IMAGE is required}"

namespace="$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace)"
token="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"
ca="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
api_root="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS}"
object_store="vhhealth-pg18-reader"
cluster="vhhealth-pg-restore-proof"
store_path="/apis/barmancloud.cnpg.io/v1/namespaces/${namespace}/objectstores/${object_store}"
cluster_path="/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters/${cluster}"
created_store=false
created_cluster=false
store_uid=""
cluster_uid=""

request() {
  method="$1"
  path="$2"
  body="${3:-}"
  if [ -n "${body}" ]; then
    curl --fail --silent --show-error --cacert "${ca}" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      -X "${method}" --data-binary "${body}" "${api_root}${path}"
  else
    curl --fail --silent --show-error --cacert "${ca}" \
      -H "Authorization: Bearer ${token}" \
      -X "${method}" "${api_root}${path}"
  fi
}

request_status() {
  curl --silent --output /dev/null --write-out '%{http_code}' --cacert "${ca}" \
    -H "Authorization: Bearer ${token}" "${api_root}$1"
}

extract_uid() {
  printf '%s' "$1" |
    sed -n 's/.*"uid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

verify_disposable_identity() {
  path="$1"
  expected_uid="$2"
  resource="$(request GET "${path}")" || return 1
  printf '%s' "${resource}" |
    grep -Eq '"vhhealth\.app/disposable-restore-proof"[[:space:]]*:[[:space:]]*"true"' ||
    return 1
  printf '%s' "${resource}" |
    grep -Eq "\"uid\"[[:space:]]*:[[:space:]]*\"${expected_uid}\"" ||
    return 1
}

delete_with_uid() {
  path="$1"
  uid="$2"
  request DELETE "${path}" \
    "{\"apiVersion\":\"v1\",\"kind\":\"DeleteOptions\",\"preconditions\":{\"uid\":\"${uid}\"}}" >/dev/null
}

wait_for_absence() {
  path="$1"
  deadline=$(( $(date +%s) + 600 ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    status="$(request_status "${path}")"
    [ "${status}" = "404" ] && return 0
    [ "${status}" = "200" ] || {
      echo "Unexpected API status ${status} while waiting for ${path} deletion" >&2
      return 1
    }
    sleep 5
  done
  echo "Timed out waiting for ${path} deletion" >&2
  return 1
}

cleanup() {
  original_status=$?
  trap - EXIT INT TERM
  cleanup_failed=false
  cluster_absent=true

  if [ "${created_cluster}" = true ]; then
    if [ -n "${cluster_uid}" ] &&
       verify_disposable_identity "${cluster_path}" "${cluster_uid}"; then
      delete_with_uid "${cluster_path}" "${cluster_uid}" || cleanup_failed=true
      if ! wait_for_absence "${cluster_path}"; then
        cleanup_failed=true
        cluster_absent=false
      fi
    else
      echo "Refusing to delete Cluster: disposable label or created UID no longer matches" >&2
      cleanup_failed=true
      cluster_absent=false
    fi
  fi

  if [ "${created_store}" = true ]; then
    if [ "${cluster_absent}" != true ]; then
      echo "Refusing to delete ObjectStore before the created Cluster is confirmed absent" >&2
      cleanup_failed=true
    elif [ -n "${store_uid}" ] &&
         verify_disposable_identity "${store_path}" "${store_uid}"; then
      delete_with_uid "${store_path}" "${store_uid}" || cleanup_failed=true
    else
      echo "Refusing to delete ObjectStore: disposable label or created UID no longer matches" >&2
      cleanup_failed=true
    fi
  fi

  if [ "${original_status}" -eq 0 ] && [ "${cleanup_failed}" = true ]; then
    exit 1
  fi
  exit "${original_status}"
}
trap cleanup EXIT INT TERM

store_body="$(cat <<EOF
{"apiVersion":"barmancloud.cnpg.io/v1","kind":"ObjectStore","metadata":{"name":"${object_store}","namespace":"${namespace}","labels":{"vhhealth.app/disposable-restore-proof":"true"}},"spec":{"configuration":{"destinationPath":"s3://${R2_BUCKET}/${R2_PREFIX}","endpointURL":"${R2_ENDPOINT}","s3Credentials":{"accessKeyId":{"name":"cnpg-dr-reader-credentials","key":"ACCESS_KEY_ID"},"secretAccessKey":{"name":"cnpg-dr-reader-credentials","key":"SECRET_ACCESS_KEY"}},"wal":{"compression":"gzip"},"data":{"compression":"gzip"}}}}
EOF
)"
store_response="$(request POST "/apis/barmancloud.cnpg.io/v1/namespaces/${namespace}/objectstores" "${store_body}")"
created_store=true
store_uid="$(extract_uid "${store_response}")"
[ -n "${store_uid}" ] || {
  echo "Created ObjectStore response omitted metadata.uid; refusing unsafe cleanup" >&2
  exit 1
}

cluster_body="$(cat <<EOF
{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","metadata":{"name":"${cluster}","namespace":"${namespace}","labels":{"vhhealth.app/disposable-restore-proof":"true"}},"spec":{"description":"Suspended scheduled proof of latest PG18 backup","imageName":"${PG18_IMAGE}","instances":1,"enableSuperuserAccess":false,"storage":{"size":"110Gi","storageClass":"local-path"},"walStorage":{"size":"25Gi","storageClass":"local-path"},"resources":{"requests":{"memory":"1Gi","cpu":"500m"},"limits":{"memory":"4Gi","cpu":"2"}},"bootstrap":{"recovery":{"source":"vhhealth-pg18-r2"}},"externalClusters":[{"name":"vhhealth-pg18-r2","plugin":{"name":"barman-cloud.cloudnative-pg.io","parameters":{"barmanObjectName":"${object_store}","serverName":"${BARMAN_SERVER_NAME}"}}}]}}
EOF
)"
cluster_response="$(request POST "/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters" "${cluster_body}")"
created_cluster=true
cluster_uid="$(extract_uid "${cluster_response}")"
[ -n "${cluster_uid}" ] || {
  echo "Created Cluster response omitted metadata.uid; refusing unsafe cleanup" >&2
  exit 1
}

deadline=$(( $(date +%s) + 6600 ))
while [ "$(date +%s)" -lt "${deadline}" ]; do
  status="$(request GET "${cluster_path}")"
  if printf '%s' "${status}" | grep -q '"phase":"Cluster in healthy state"'; then
    printf 'restore_proof=passed cluster=%s cluster_uid=%s archive=%s\n' \
      "${cluster}" "${cluster_uid}" "${BARMAN_SERVER_NAME}"
    exit 0
  fi
  sleep 20
done

echo "Restore proof timed out before the cluster became healthy" >&2
exit 1
