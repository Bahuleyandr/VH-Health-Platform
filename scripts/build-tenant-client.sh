#!/usr/bin/env bash
# build-tenant-client.sh — multi-tenancy W6 T4 / W7 per-tenant client build helper.
#
# Produces the patient + staff Flutter builds for ONE tenant, stamping the build
# with the tenant's subdomain + identity via --dart-define (the app code consumes
# these via ApiConfig.baseUrl + TenantConfig — W6 T1–T3). The default (unstamped)
# build is unchanged; this only adds the per-tenant defines.
#
# This wraps `flutter build`; the Android product flavors / iOS schemes, signing
# configs, and per-tenant Firebase config (one shared google-services.json now →
# per-tenant per flavor later) are wired by the operator — see
# docs/TENANT_ONBOARDING_RUNBOOK.md (Part B4). Run from the repo root.
#
# Usage:
#   scripts/build-tenant-client.sh --slug acme --tenant-id <uuid> --api-key <key> \
#     --cert-pin-hashes <current,next> --clock-skew-seconds 300 \
#     [--min-version-current-key-id <id>] [--min-version-current-public-key <base64>] \
#     [--min-version-next-key-id <id>] [--min-version-next-public-key <base64>] \
#     [--base-host api.vhhealth.app] [--primary "#1565C0"] \
#     [--apps patient,staff] [--target apk|appbundle|ios] [--dry-run]
set -euo pipefail

SLUG=""; TENANT_ID=""; API_KEY=""; BASE_HOST="vhhealth.app"; PRIMARY=""
CERT_PIN_HASHES="${CERT_PIN_HASHES:-}"
CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS="${CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS:-}"
PATIENT_MIN_VERSION_CURRENT_KEY_ID="${PATIENT_MIN_VERSION_CURRENT_KEY_ID:-}"
PATIENT_MIN_VERSION_CURRENT_PUBLIC_KEY_BASE64="${PATIENT_MIN_VERSION_CURRENT_PUBLIC_KEY_BASE64:-}"
PATIENT_MIN_VERSION_NEXT_KEY_ID="${PATIENT_MIN_VERSION_NEXT_KEY_ID:-}"
PATIENT_MIN_VERSION_NEXT_PUBLIC_KEY_BASE64="${PATIENT_MIN_VERSION_NEXT_PUBLIC_KEY_BASE64:-}"
APPS="patient,staff"; TARGET="apk"; DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2;;
    --tenant-id) TENANT_ID="$2"; shift 2;;
    --api-key) API_KEY="$2"; shift 2;;
    --base-host) BASE_HOST="$2"; shift 2;;
    --primary) PRIMARY="$2"; shift 2;;
    --cert-pin-hashes) CERT_PIN_HASHES="$2"; shift 2;;
    --clock-skew-seconds) CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS="$2"; shift 2;;
    --min-version-current-key-id) PATIENT_MIN_VERSION_CURRENT_KEY_ID="$2"; shift 2;;
    --min-version-current-public-key) PATIENT_MIN_VERSION_CURRENT_PUBLIC_KEY_BASE64="$2"; shift 2;;
    --min-version-next-key-id) PATIENT_MIN_VERSION_NEXT_KEY_ID="$2"; shift 2;;
    --min-version-next-public-key) PATIENT_MIN_VERSION_NEXT_PUBLIC_KEY_BASE64="$2"; shift 2;;
    --apps) APPS="$2"; shift 2;;
    --target) TARGET="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

[[ -z "$SLUG" ]] && { echo "✗ --slug is required" >&2; exit 2; }
[[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$ ]] && { echo "✗ --slug must be lowercase [a-z0-9-], 3–40 chars" >&2; exit 2; }
[[ -z "$TENANT_ID" ]] && { echo "✗ --tenant-id (uuid) is required" >&2; exit 2; }
[[ -z "$API_KEY" && "$DRY_RUN" -eq 0 ]] && { echo "✗ --api-key is required (or use --dry-run)" >&2; exit 2; }
node scripts/validate-cert-pin-set.mjs \
  --pins "$CERT_PIN_HASHES" \
  --clock-skew-seconds "$CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS"
node scripts/validate-patient-minimum-version-trust.mjs \
  --current-key-id "$PATIENT_MIN_VERSION_CURRENT_KEY_ID" \
  --current-public-key "$PATIENT_MIN_VERSION_CURRENT_PUBLIC_KEY_BASE64" \
  --next-key-id "$PATIENT_MIN_VERSION_NEXT_KEY_ID" \
  --next-public-key "$PATIENT_MIN_VERSION_NEXT_PUBLIC_KEY_BASE64"

BASE_URL="https://${SLUG}-api.${BASE_HOST}/api/v1"   # flat: <slug>-api.<base>

# Map the Flutter build target to the per-app package dir + flutter sub-command.
declare -A APP_DIR=( [patient]="apps/patient" [staff]="apps/staff" )

run_build() {
  local app="$1" dir="${APP_DIR[$app]:-}"
  [[ -z "$dir" ]] && { echo "✗ unknown app '$app' (expected patient|staff)" >&2; exit 2; }
  local defines=(
    "--dart-define=VH_BASE_URL=${BASE_URL}"
    "--dart-define=VH_TENANT_SLUG=${SLUG}"
    "--dart-define=VH_TENANT_ID=${TENANT_ID}"
    "--dart-define=VH_API_KEY=${API_KEY}"
    "--dart-define=PRODUCTION=true"
    "--dart-define=CERT_PIN_HASHES=${CERT_PIN_HASHES}"
    "--dart-define=CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS=${CLIENT_READINESS_MAX_CLOCK_SKEW_SECONDS}"
  )
  [[ -n "$PRIMARY" ]] && defines+=( "--dart-define=VH_TENANT_PRIMARY=${PRIMARY}" )
  if [[ "$app" == "patient" && -n "$PATIENT_MIN_VERSION_CURRENT_KEY_ID" ]]; then
    defines+=(
      "--dart-define=VH_PATIENT_MIN_VERSION_CURRENT_KEY_ID=${PATIENT_MIN_VERSION_CURRENT_KEY_ID}"
      "--dart-define=VH_PATIENT_MIN_VERSION_CURRENT_PUBLIC_KEY_BASE64=${PATIENT_MIN_VERSION_CURRENT_PUBLIC_KEY_BASE64}"
    )
    if [[ -n "$PATIENT_MIN_VERSION_NEXT_KEY_ID" ]]; then
      defines+=(
        "--dart-define=VH_PATIENT_MIN_VERSION_NEXT_KEY_ID=${PATIENT_MIN_VERSION_NEXT_KEY_ID}"
        "--dart-define=VH_PATIENT_MIN_VERSION_NEXT_PUBLIC_KEY_BASE64=${PATIENT_MIN_VERSION_NEXT_PUBLIC_KEY_BASE64}"
      )
    fi
  fi
  # --flavor <slug> assumes the operator has declared the per-tenant flavor
  # (Android) / scheme (iOS) + dropped in the tenant's Firebase config + signing.
  local cmd=( flutter build "$TARGET" --release --flavor "$SLUG" "${defines[@]}" )
  echo "  ▶ ${app}  (cd ${dir})"
  echo "      ${cmd[*]}"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    ( cd "$dir" && "${cmd[@]}" )
  fi
}

echo ""
echo "▶ Per-tenant client build — tenant '${SLUG}' → ${BASE_URL}${DRY_RUN:+}"
[[ "$DRY_RUN" -eq 1 ]] && echo "  [DRY RUN — printing commands only]"
echo ""

# Regenerate the OpenAPI Dart client before any build. packages/vhhealth_core/
# lib/api/generated/ is gitignored (packages/vhhealth_core/.gitignore), so on a
# fresh clone it does not exist — yet the tracked barrel lib/api/vhhealth_api.dart
# re-exports it and both apps import generated symbols, so `flutter build` below
# fails without this. Same step the CI workflows run as `melos run codegen`.
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  [dry-run] node scripts/codegen.mjs"
else
  echo "  ▶ codegen (regenerate Dart client from synced spec)"
  node scripts/codegen.mjs
fi
echo ""

IFS=',' read -ra APP_LIST <<< "$APPS"
for app in "${APP_LIST[@]}"; do run_build "$app"; done
echo ""
echo "  Done. Distribute each build via the tenant's store listing / Firebase App Distribution."
echo "  (Firebase: shared project now → per-tenant google-services.json per flavor later.)"
