<#
.SYNOPSIS
Runs a read-only Clinical AI tenant rollout preflight.

.DESCRIPTION
Checks the tenant, schema, module catalogue, reviewer staffing, audit trail,
output-defense evidence, and optional pilot signoff before Stage 1 rollout.
The script never mutates product data. Manual attestations are reported
explicitly so a tenant cannot be treated as rollout-ready without human
approval of workflow, PHI logging, safety cadence, and patient-dispatch policy.
#>
[CmdletBinding()]
param(
  [string]$TenantId = "00000000-0000-4000-8000-000000000001",
  [string]$PilotStage = "stage_1_clinical_review",
  [string[]]$PilotModules = @("medication_reconciliation", "patient_aftercare_instructions"),
  [string]$PgHost = "127.0.0.1",
  [int]$PgPort = 55432,
  [string]$PgUser = "postgres",
  [string]$PgDatabase = "vhhealth_test",
  [string]$PgPassword = "",
  [string]$PsqlPath = "psql",
  [string]$BackendBase = "",
  [switch]$RequirePilotSignoff,
  [switch]$RequireRolloutReady,
  [switch]$ReviewerQueueWalkthroughConfirmed,
  [switch]$PhiLoggingReviewed,
  [switch]$SafetyReviewCadenceConfirmed,
  [switch]$NoAutomaticPatientDispatchConfirmed,
  [switch]$Json,
  [string]$OutputPath = "",
  [switch]$RequireNoWarnings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib/smoke-results.ps1")

# One formatter for both call sites below, so the crash path cannot print
# a differently-shaped table from the normal path.
$preflightResultFormatter = {
  param($rows)
  $rows | Format-Table name, status, detail -AutoSize
}

$script:Results = [System.Collections.Generic.List[object]]::new()

try {

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Escape-SqlText {
  param([AllowNull()][string]$Value)
  return ([string]$Value).Replace("'", "''")
}

function Invoke-Psql {
  param([Parameter(Mandatory)][string]$Sql)

  $previousPassword = $env:PGPASSWORD
  $env:PGPASSWORD = $PgPassword
  try {
    $output = & $PsqlPath -v ON_ERROR_STOP=1 -qAt -h $PgHost -p $PgPort -U $PgUser -d $PgDatabase -c $Sql
    if ($LASTEXITCODE -ne 0) {
      throw "psql exited with code $LASTEXITCODE"
    }
    return (($output | Out-String).Trim())
  } finally {
    $env:PGPASSWORD = $previousPassword
  }
}

function Write-JsonArtifact {
  param(
    [string]$Path,
    [Parameter(Mandatory)]$Payload
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $Payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Add-Check {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][ValidateSet("PASS", "WARN", "FAIL", "MANUAL")] [string]$Status,
    [Parameter(Mandatory)][string]$Detail,
    [string]$Remediation = ""
  )

  $script:Results.Add([pscustomobject]@{
    name = $Name
    status = $Status
    automated_ok = $Status -ne "FAIL"
    rollout_ready = $Status -eq "PASS"
    detail = $Detail
    remediation = $Remediation
  }) | Out-Null
}

function Add-ManualCheck {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][bool]$Confirmed,
    [Parameter(Mandatory)][string]$Detail
  )

  if ($Confirmed) {
    Add-Check $Name "PASS" $Detail
  } else {
    Add-Check $Name "MANUAL" $Detail "Confirm this with the hospital clinical lead before rollout."
  }
}

function New-TextArraySql {
  param([string[]]$Values)
  $items = @($Values | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique | ForEach-Object {
    "'" + (Escape-SqlText $_) + "'"
  })
  if ($items.Count -eq 0) {
    return "ARRAY[]::text[]"
  }
  return "ARRAY[$($items -join ',')]::text[]"
}

Assert-Command $PsqlPath

$tenantSql = Escape-SqlText $TenantId
$pilotStageSql = Escape-SqlText $PilotStage
$pilotModulesSql = New-TextArraySql $PilotModules
$pilotModulesJson = ConvertTo-Json -Compress -InputObject @($PilotModules | Select-Object -Unique)
$pilotModulesJsonSql = Escape-SqlText $pilotModulesJson

$tenantRow = Invoke-Psql @"
SELECT concat_ws('|',
  id::text,
  slug,
  name,
  status,
  region,
  COALESCE(settings->>'locale', settings->>'default_locale', '')
)
FROM tenants
WHERE id = '$tenantSql'::uuid
LIMIT 1;
"@

if ([string]::IsNullOrWhiteSpace($tenantRow)) {
  Add-Check "tenant_exists" "FAIL" "Tenant $TenantId was not found." "Create or select the tenant before enabling Clinical AI."
} else {
  $tenantParts = @($tenantRow -split '\|', 6)
  $tenantStatus = if ($tenantParts.Length -gt 3) { $tenantParts[3] } else { "" }
  $tenantRegion = if ($tenantParts.Length -gt 4) { $tenantParts[4] } else { "" }
  $tenantLocale = if ($tenantParts.Length -gt 5) { $tenantParts[5] } else { "" }

  Add-Check "tenant_exists" "PASS" "Tenant $TenantId exists as $($tenantParts[1])."
  if ($tenantStatus -eq "active") {
    Add-Check "tenant_active" "PASS" "Tenant status is active."
  } else {
    Add-Check "tenant_active" "FAIL" "Tenant status is $tenantStatus." "Activate the tenant or choose an active tenant."
  }
  if (-not [string]::IsNullOrWhiteSpace($tenantRegion)) {
    Add-Check "tenant_region_set" "PASS" "Tenant region is $tenantRegion."
  } else {
    Add-Check "tenant_region_set" "FAIL" "Tenant region is blank." "Set tenants.region before routing Clinical AI."
  }
  if (-not [string]::IsNullOrWhiteSpace($tenantLocale)) {
    Add-Check "tenant_locale_set" "PASS" "Tenant locale is $tenantLocale."
  } else {
    Add-Check "tenant_locale_set" "WARN" "Tenant settings.locale/default_locale is not set; backend defaults may still use English." "Set tenants.settings.locale for multilingual pilots."
  }
}

$requiredTables = @(
  "clinical_ai_modules",
  "clinical_ai_tenant_modules",
  "clinical_ai_generations",
  "clinical_ai_reviews",
  "clinical_ai_workflow_runs",
  "clinical_ai_safety_reviews",
  "clinical_ai_model_eval_runs",
  "clinical_ai_approvals",
  "audit_logs"
)
$requiredTablesSql = New-TextArraySql $requiredTables
$presentTablesRaw = Invoke-Psql @"
SELECT COALESCE(string_agg(table_name, ',' ORDER BY table_name), '')
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = ANY($requiredTablesSql);
"@
$presentTables = @($presentTablesRaw -split ',' | Where-Object { $_ })
$missingTables = @($requiredTables | Where-Object { $presentTables -notcontains $_ })
if ($missingTables.Count -eq 0) {
  Add-Check "clinical_ai_schema_present" "PASS" "All required Clinical AI governance tables exist."
} else {
  Add-Check "clinical_ai_schema_present" "FAIL" "Missing tables: $($missingTables -join ', ')." "Apply migrations before rollout."
}

$catalogModules = @($PilotModules + @("lab_tat_delay_prediction") | Select-Object -Unique)
$catalogModulesSql = New-TextArraySql $catalogModules
$catalogCount = [int](Invoke-Psql @"
SELECT COUNT(*)
FROM clinical_ai_modules
WHERE module_key = ANY($catalogModulesSql);
"@)
if ($catalogCount -eq $catalogModules.Count) {
  Add-Check "module_catalog_ready" "PASS" "Required module catalogue rows are present: $($catalogModules -join ', ')."
} else {
  Add-Check "module_catalog_ready" "FAIL" "Expected $($catalogModules.Count) module rows, found $catalogCount." "Apply Clinical AI module migrations/seeds."
}

$guardrailsRow = Invoke-Psql @"
SELECT concat_ws('|', enabled::text, external_ai_enabled::text, COALESCE(fallback_rate_alert_pct::text, ''), COALESCE(latency_alert_ms::text, ''))
FROM clinical_ai_guardrails
WHERE id = 1
LIMIT 1;
"@
if ([string]::IsNullOrWhiteSpace($guardrailsRow)) {
  Add-Check "guardrails_configured" "FAIL" "No clinical_ai_guardrails row with id=1 exists." "Seed and review Clinical AI guardrails."
} else {
  $guardrailParts = @($guardrailsRow -split '\|')
  if ($guardrailParts[0] -eq "true") {
    Add-Check "guardrails_configured" "PASS" "Clinical AI guardrails are enabled."
  } else {
    Add-Check "guardrails_configured" "FAIL" "Clinical AI guardrails are disabled." "Enable guardrails before module rollout."
  }
}

# Per-module reviewer staffing + deep-tier liveness (Enablement-plan C2 + C3).
# Delegates to the service-accurate node checker, which reads each ENABLED
# module's OWN reviewRoles (replacing the old fixed tenant-wide allowlist that
# missed RADIOLOGIST/MEDICAL_RECORDS/coder roles — C2) and asserts deep-tagged
# modules produce real AI rather than silently template-falling-back
# (assertDeepModuleLive — C3). Its failures/warnings fold into this gate.
$moduleCheckScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/backend/scripts/check-clinical-ai-tenant-preflight.mjs'
if (Test-Path $moduleCheckScript) {
  $prevDbUrl = $env:DATABASE_URL
  if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
    $env:DATABASE_URL = "postgresql://$($PgUser):$($PgPassword)@$($PgHost):$($PgPort)/$($PgDatabase)"
  }
  try {
    $moduleCheckRaw = & node $moduleCheckScript --tenant $TenantId --json 2>$null | Out-String
    $moduleCheck = $moduleCheckRaw | ConvertFrom-Json
    Add-Check "modules_enabled" "PASS" "$($moduleCheck.modules_enabled) of $($moduleCheck.modules_total) module(s) enabled for tenant."
    $reviewerFailures = @($moduleCheck.failures | Where-Object { $_.issue -eq 'no_reviewers_staffed' })
    if ($reviewerFailures.Count -eq 0) {
      Add-Check "per_module_reviewer_staffing" "PASS" "Every enabled module has at least one staffed reviewer role (per-module reviewRoles)."
    } else {
      foreach ($f in $reviewerFailures) {
        Add-Check "reviewers_$($f.module)" "FAIL" "Enabled module '$($f.module)' has zero staffed reviewers." "Assign an active user with one of: $($f.reviewRoles -join ', ')."
      }
    }
    foreach ($w in @($moduleCheck.warnings)) {
      $wReason = if (($w.PSObject.Properties.Name -contains 'reason') -and $w.reason) { " ($($w.reason))" } else { "" }
      Add-Check "module_$($w.module)_$($w.issue)" "WARN" "Module '$($w.module)': $($w.issue)$wReason." "Review before -RequireNoWarnings rollout."
    }
  } catch {
    Add-Check "per_module_reviewer_staffing" "WARN" "Per-module reviewer/deep-tier check could not run: $($_.Exception.Message)" "Run apps/backend/scripts/check-clinical-ai-tenant-preflight.mjs --tenant $TenantId manually."
  } finally {
    $env:DATABASE_URL = $prevDbUrl
  }
} else {
  Add-Check "per_module_reviewer_staffing" "WARN" "Per-module reviewer/deep checker not found at $moduleCheckScript." "Restore apps/backend/scripts/check-clinical-ai-tenant-preflight.mjs."
}

$recentGenerationRow = Invoke-Psql @"
SELECT concat_ws('|',
  COUNT(*)::text,
  COUNT(*) FILTER (WHERE metadata ? 'output_defenses_ran')::text,
  COUNT(*) FILTER (WHERE metadata->>'no_heuristic_flags' = 'true')::text
)
FROM clinical_ai_generations
WHERE tenant_id = '$tenantSql'::uuid
  AND created_at >= NOW() - INTERVAL '30 days';
"@
$generationParts = @($recentGenerationRow -split '\|')
$generationCount = [int]$generationParts[0]
$defenseVisibleCount = [int]$generationParts[1]
$defensePassedCount = [int]$generationParts[2]
if ($generationCount -eq 0) {
  Add-Check "output_defenses_visible" "WARN" "No recent Clinical AI generation rows exist for this tenant." "Run the first-pilot smoke or a supervised sample generation before rollout."
} elseif ($defenseVisibleCount -ge 1 -and $defensePassedCount -ge 1) {
  Add-Check "output_defenses_visible" "PASS" "Recent generation rows expose output_defenses_ran and defenses_passed metadata."
} else {
  Add-Check "output_defenses_visible" "FAIL" "Recent generations exist, but defense metadata is missing or not passing." "Verify runOutputDefenses wiring before rollout."
}

$auditCount = [int](Invoke-Psql @"
SELECT COUNT(*)
FROM audit_logs
WHERE (resource = 'clinical_ai' OR action LIKE 'CLINICAL_AI_%')
  AND COALESCE(metadata->>'tenant_id', '$tenantSql') = '$tenantSql'
  AND created_at >= (NOW() AT TIME ZONE current_setting('TimeZone')) - INTERVAL '30 days';
"@)
if ($auditCount -ge 1) {
  Add-Check "clinical_ai_audit_trail" "PASS" "Found $auditCount recent Clinical AI audit event(s) for the tenant."
} else {
  Add-Check "clinical_ai_audit_trail" "FAIL" "No recent Clinical AI audit events found for tenant." "Run a sample Clinical AI workflow and verify audit logging."
}

$numberingCount = [int](Invoke-Psql "SELECT COUNT(*) FROM numbering_series WHERE tenant_id = '$tenantSql'::uuid AND status = 'active';")
if ($numberingCount -ge 1) {
  Add-Check "numbering_series_seeded" "PASS" "Found $numberingCount active numbering series row(s)."
} else {
  Add-Check "numbering_series_seeded" "WARN" "No active numbering series rows found for tenant." "Seed numbering series before modules that emit identifiers."
}

$retentionCount = [int](Invoke-Psql @"
SELECT COUNT(*)
FROM data_retention_policies
WHERE tenant_id = '$tenantSql'::uuid
  AND status = 'active'
  AND applies_to_table = ANY(ARRAY['clinical_ai_generations','clinical_ai_reviews','clinical_ai_model_eval_runs','audit_logs']::text[]);
"@)
if ($retentionCount -ge 1) {
  Add-Check "retention_policy_reviewed" "PASS" "Found $retentionCount active AI/audit retention policy row(s)."
} else {
  Add-Check "retention_policy_reviewed" "WARN" "No active AI/audit retention policy rows found." "Review and seed data_retention_policies for Clinical AI/audit tables."
}

$signoffStatus = "none"
$signoffDetail = "No pilot signoff found for stage $PilotStage and modules $($PilotModules -join ', ')."
$signoffRow = Invoke-Psql @"
SELECT concat_ws('|',
  status,
  COALESCE(payload->>'pilot_ready', ''),
  COALESCE(payload->>'blocker_count', ''),
  (expires_at > NOW())::text,
  COALESCE(payload->>'pack_hash', '')
)
FROM clinical_ai_approvals
WHERE tenant_id = '$tenantSql'::uuid
  AND approval_type = 'pilot_evidence_pack_signoff'
  AND payload->>'pilot_stage' = '$pilotStageSql'
  AND (payload->'module_keys') @> '$pilotModulesJsonSql'::jsonb
  AND '$pilotModulesJsonSql'::jsonb @> (payload->'module_keys')
ORDER BY created_at DESC
LIMIT 1;
"@
if (-not [string]::IsNullOrWhiteSpace($signoffRow)) {
  $signoffParts = @($signoffRow -split '\|')
  $signoffStatus = $signoffParts[0]
  $signoffReady = if ($signoffParts.Length -gt 1) { $signoffParts[1] } else { "" }
  $signoffBlockers = if ($signoffParts.Length -gt 2) { $signoffParts[2] } else { "" }
  $signoffUnexpired = if ($signoffParts.Length -gt 3) { $signoffParts[3] } else { "" }
  $signoffHash = if ($signoffParts.Length -gt 4) { $signoffParts[4] } else { "" }
  $signoffDetail = "latest=$signoffStatus pilotReady=$signoffReady blockers=$signoffBlockers unexpired=$signoffUnexpired hash=$signoffHash"
}
if ($signoffStatus -eq "approved" -and $signoffDetail -match "pilotReady=true" -and $signoffDetail -match "blockers=0" -and $signoffDetail -match "unexpired=true") {
  Add-Check "pilot_signoff_gate" "PASS" $signoffDetail
} elseif ($RequirePilotSignoff) {
  Add-Check "pilot_signoff_gate" "FAIL" $signoffDetail "Approve an unexpired pilot evidence signoff for the exact stage and module set."
} else {
  Add-Check "pilot_signoff_gate" "WARN" $signoffDetail "Required before expanding beyond the first pilot scope."
}

if (-not [string]::IsNullOrWhiteSpace($BackendBase)) {
  try {
    $healthUri = "$($BackendBase.TrimEnd('/'))/api/v1/health"
    $response = Invoke-WebRequest -Uri $healthUri -UseBasicParsing -TimeoutSec 5
    Add-Check "backend_health" "PASS" "Backend health returned $($response.StatusCode) at $healthUri."
  } catch {
    Add-Check "backend_health" "FAIL" "Backend health failed: $($_.Exception.Message)" "Start the backend and verify tenant env before rollout."
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$phiMiddleware = Join-Path $repoRoot "apps\backend\src\middleware\phiAccessMiddleware.js"
$routeRoot = Join-Path $repoRoot "apps\backend\src\routes"
if ((Test-Path $phiMiddleware) -and (Test-Path $routeRoot)) {
  $phiRouteUses = @(Get-ChildItem -Path $routeRoot -Recurse -Filter "*.js" | Select-String -Pattern "phiAccessLogger").Count
  if ($phiRouteUses -ge 1) {
    Add-Check "phi_logger_wired_in_code" "PASS" "phiAccessLogger middleware exists and is referenced $phiRouteUses time(s)."
  } else {
    Add-Check "phi_logger_wired_in_code" "WARN" "phiAccessLogger exists but no route references were found." "Review PHI route middleware before rollout."
  }
} else {
  Add-Check "phi_logger_wired_in_code" "WARN" "Source tree not available for PHI middleware scan." "Review deployed PHI logging configuration manually."
}

Add-ManualCheck "review_queue_walkthrough" ([bool]$ReviewerQueueWalkthroughConfirmed) "Reviewer queue walkthrough and sample signoff confirmed."
Add-ManualCheck "phi_logging_reviewed" ([bool]$PhiLoggingReviewed) "PHI access logging reviewed for routes feeding selected modules."
Add-ManualCheck "safety_review_cadence" ([bool]$SafetyReviewCadenceConfirmed) "Weekly high/critical AI safety-review cadence confirmed."
Add-ManualCheck "no_auto_patient_dispatch" ([bool]$NoAutomaticPatientDispatchConfirmed) "Automatic patient dispatch disabled for pilot drafts."

$automatedFailures = @($script:Results | Where-Object { $_.status -eq "FAIL" })
$manualPending = @($script:Results | Where-Object { $_.status -eq "MANUAL" })
$warnings = @($script:Results | Where-Object { $_.status -eq "WARN" })
$summary = [pscustomobject]@{
  tenant_id = $TenantId
  pilot_stage = $PilotStage
  pilot_modules = $PilotModules
  automated_preflight_ok = $automatedFailures.Count -eq 0
  warning_gate_ok = (-not $RequireNoWarnings -or $warnings.Count -eq 0)
  rollout_ready = ($automatedFailures.Count -eq 0 -and $manualPending.Count -eq 0 -and (-not $RequireNoWarnings -or $warnings.Count -eq 0))
  failure_count = $automatedFailures.Count
  warning_count = $warnings.Count
  manual_pending_count = $manualPending.Count
}

$preflightPayload = [pscustomobject]@{
  summary = $summary
  checks = $script:Results
}

Write-JsonArtifact -Path $OutputPath -Payload $preflightPayload

if ($Json) {
  Write-SmokeResults -Results $script:Results -Quiet
  $preflightPayload | ConvertTo-Json -Depth 8
} else {
  Write-SmokeResults -Results $script:Results -Formatter $preflightResultFormatter
  $summary | Format-List | Out-String | Write-Host
}

if ($automatedFailures.Count -gt 0) {
  throw "Clinical AI tenant preflight failed: $($automatedFailures.Count) automated check(s) failed."
}
if ($RequireRolloutReady -and $manualPending.Count -gt 0) {
  throw "Clinical AI tenant preflight is not rollout-ready: $($manualPending.Count) manual attestation(s) pending."
}
if ($RequireNoWarnings -and $warnings.Count -gt 0) {
  throw "Clinical AI tenant preflight is not warning-clean: $($warnings.Count) warning(s) found."
}
} finally {
  # A terminating error above must not discard the checks already recorded.
  # Write-SmokeResults is idempotent, so the normal path prints where it
  # always did and this is a no-op after it.
  Write-SmokeResults -Results $script:Results -Formatter $preflightResultFormatter
}
