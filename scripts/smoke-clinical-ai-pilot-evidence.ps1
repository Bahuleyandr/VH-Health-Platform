<#
.SYNOPSIS
Runs a Clinical AI pilot evidence-pack smoke against the backend.

.DESCRIPTION
Assumes the local backend and Postgres smoke database are already running. The
script seeds a narrow, disposable first-pilot evidence window for medication
reconciliation plus patient aftercare instructions, calls the real admin
evidence-pack endpoint, and asserts that the pack is tenant-scoped,
human-reviewed, eval-gated, visibly labelled, and redacted.
#>
[CmdletBinding()]
param(
  [string]$BackendBase = "http://127.0.0.1:5206",
  [string]$BackendDir = "",
  [string]$TenantId = "00000000-0000-4000-8000-000000000001",
  [string]$ReviewerUid = "88888888-8888-4888-8888-888888888888",
  [string]$PatientUid = "55555555-5555-4555-8555-555555555555",
  [string]$JwtSecret = "vhhealth-local-admin-smoke-secret-123456789",
  [string]$ApiKey = "vhhealth-local-api-key",
  [string]$PgHost = "127.0.0.1",
  [int]$PgPort = 55432,
  [string]$PgUser = "postgres",
  [string]$PgDatabase = "vhhealth_test",
  [string]$PgPassword = "",
  [string]$PsqlPath = "psql"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SmokeName = "clinical_ai_pilot_evidence"
$PilotStage = "ci_first_pilot_smoke"
$PilotModules = @("medication_reconciliation", "patient_aftercare_instructions")

if ([string]::IsNullOrWhiteSpace($BackendDir)) {
  $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $BackendDir = Join-Path $scriptRoot "..\apps\backend"
}

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

function New-SmokeToken {
  param(
    [Parameter(Mandatory)][string]$Uid,
    [Parameter(Mandatory)][string]$Role,
    [Parameter(Mandatory)][string]$TokenTenantId
  )

  $previousSecret = $env:SMOKE_JWT_SECRET
  $previousUid = $env:SMOKE_UID
  $previousRole = $env:SMOKE_ROLE
  $previousTenant = $env:SMOKE_TENANT_ID
  $env:SMOKE_JWT_SECRET = $JwtSecret
  $env:SMOKE_UID = $Uid
  $env:SMOKE_ROLE = $Role
  $env:SMOKE_TENANT_ID = $TokenTenantId

  try {
    Push-Location $BackendDir
    try {
      $script = @'
const jwt = require('jsonwebtoken');
const uid = process.env.SMOKE_UID;
const role = process.env.SMOKE_ROLE;
const tenantId = process.env.SMOKE_TENANT_ID;
console.log(jwt.sign({
  uid,
  sub: uid,
  role,
  tenant_id: tenantId,
  email: `${uid}@clinical-ai-pilot-smoke.local`
}, process.env.SMOKE_JWT_SECRET, { expiresIn: '4h' }));
'@
      $token = & node -e $script
      if ($LASTEXITCODE -ne 0) {
        throw "node token generation failed with code $LASTEXITCODE"
      }
      return (($token | Out-String).Trim())
    } finally {
      Pop-Location
    }
  } finally {
    $env:SMOKE_JWT_SECRET = $previousSecret
    $env:SMOKE_UID = $previousUid
    $env:SMOKE_ROLE = $previousRole
    $env:SMOKE_TENANT_ID = $previousTenant
  }
}

function Add-Result {
  param(
    [System.Collections.Generic.List[object]]$Results,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)]$Status,
    [Parameter(Mandatory)][bool]$Ok,
    [string]$Detail = ""
  )

  $Results.Add([pscustomobject]@{
    name = $Name
    status = $Status
    ok = $Ok
    detail = $Detail
  }) | Out-Null
}

function Invoke-SmokeRequest {
  param(
    [System.Collections.Generic.List[object]]$Results,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Method,
    [Parameter(Mandatory)][string]$Path,
    [object]$Body = $null,
    [string]$AuthToken = $script:AdminToken,
    [int]$ExpectedStatus = 0
  )

  $uri = "$($BackendBase.TrimEnd('/'))$Path"
  $headers = @{
    Authorization = "Bearer $AuthToken"
    "x-api-key" = $ApiKey
    Accept = "application/json"
  }

  try {
    $params = @{
      Uri = $uri
      Method = $Method
      Headers = $headers
    }
    if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey("SkipHttpErrorCheck")) {
      $params.SkipHttpErrorCheck = $true
    }

    if ($null -ne $Body) {
      $params.Body = ($Body | ConvertTo-Json -Depth 12)
      $params.ContentType = "application/json"
      $headers["Content-Type"] = "application/json"
    }

    $response = $null
    try {
      $response = Invoke-WebRequest @params
    } catch {
      $responseProperty = $_.Exception.PSObject.Properties["Response"]
      if ($null -ne $responseProperty -and $null -ne $responseProperty.Value) {
        $errorResponse = $responseProperty.Value
        if ($errorResponse.PSObject.Methods["GetResponseStream"]) {
          $reader = New-Object System.IO.StreamReader($errorResponse.GetResponseStream())
          try {
            $content = $reader.ReadToEnd()
          } finally {
            $reader.Dispose()
          }
        } elseif ($errorResponse.PSObject.Properties["Content"] -and $errorResponse.Content) {
          $content = $errorResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        } else {
          $content = ""
        }
        $response = [pscustomobject]@{
          StatusCode = [int]$errorResponse.StatusCode
          Content = $content
        }
      } else {
        throw
      }
    }

    $message = ""
    if ($response.Content) {
      try {
        $json = $response.Content | ConvertFrom-Json
        if ($json.message) {
          $message = [string]$json.message
        } elseif ($json.error) {
          $message = [string]$json.error
        }
      } catch {
        $message = $response.Content.Substring(0, [Math]::Min(160, $response.Content.Length))
      }
    }

    $ok = if ($ExpectedStatus -gt 0) {
      [int]$response.StatusCode -eq $ExpectedStatus
    } else {
      $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    }
    Add-Result $Results $Name ([int]$response.StatusCode) $ok $message
    return $response
  } catch {
    Add-Result $Results $Name "ERR" $false $_.Exception.Message
    return $null
  }
}

function Get-JsonContent {
  param($Response)

  if ($null -eq $Response -or -not $Response.Content) {
    return $null
  }
  return $Response.Content | ConvertFrom-Json
}

function Get-JsonProperty {
  param(
    $Object,
    [Parameter(Mandatory)][string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Add-ContractResult {
  param(
    [System.Collections.Generic.List[object]]$Results,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][bool]$Ok,
    [string]$Detail = ""
  )

  Add-Result $Results $Name "ASSERT" $Ok $Detail
}

function Has-JsonProperty {
  param(
    $Object,
    [Parameter(Mandatory)][string]$Name
  )

  if ($null -eq $Object) {
    return $false
  }

  return $null -ne $Object.PSObject.Properties[$Name]
}

Assert-Command "node"
Assert-Command $PsqlPath

$tenantSql = Escape-SqlText $TenantId
$reviewerSql = Escape-SqlText $ReviewerUid
$patientSql = Escape-SqlText $PatientUid
$smokeSql = Escape-SqlText $SmokeName
$stageSql = Escape-SqlText $PilotStage
$evidenceAt = (Get-Date).ToUniversalTime()
$evidenceAtIso = $evidenceAt.ToString("o")
$windowFrom = $evidenceAt.AddMinutes(-2).ToString("o")
$windowTo = $evidenceAt.AddMinutes(2).ToString("o")

$seedSql = @"
WITH seed_tenant AS (
  INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
  VALUES ('$tenantSql'::uuid, 'default', 'VH Health Default Tenant', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET status = 'active', updated_at = NOW()
  RETURNING id
),
old_safety AS (
  DELETE FROM clinical_ai_safety_reviews sr
  USING clinical_ai_generations g
  WHERE sr.generation_id = g.id
    AND g.tenant_id = '$tenantSql'::uuid
    AND g.metadata->>'smoke_name' = '$smokeSql'
  RETURNING sr.id
),
old_reviews AS (
  DELETE FROM clinical_ai_reviews r
  USING clinical_ai_generations g
  WHERE r.generation_id = g.id
    AND g.tenant_id = '$tenantSql'::uuid
    AND g.metadata->>'smoke_name' = '$smokeSql'
  RETURNING r.id
),
old_eval AS (
  DELETE FROM clinical_ai_model_eval_runs
  WHERE tenant_id = '$tenantSql'::uuid
    AND metadata->>'smoke_name' = '$smokeSql'
  RETURNING id
),
old_signoffs AS (
  DELETE FROM clinical_ai_approvals
  WHERE tenant_id = '$tenantSql'::uuid
    AND approval_type = 'pilot_evidence_pack_signoff'
    AND payload->>'pilot_stage' = '$stageSql'
  RETURNING id
),
old_audit AS (
  DELETE FROM audit_logs
  WHERE metadata->>'smoke_name' = '$smokeSql'
  RETURNING id
),
old_generations AS (
  DELETE FROM clinical_ai_generations
  WHERE tenant_id = '$tenantSql'::uuid
    AND metadata->>'smoke_name' = '$smokeSql'
  RETURNING id
),
seed_guardrails AS (
  INSERT INTO clinical_ai_guardrails (id, enabled, external_ai_enabled, fallback_rate_alert_pct, latency_alert_ms, updated_by, created_at, updated_at)
  VALUES (1, true, true, 50, 15000, '$reviewerSql'::uuid, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET enabled = true,
        updated_by = '$reviewerSql'::uuid,
        updated_at = NOW()
  RETURNING id
),
seed_modules AS (
  INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, external_allowed, settings, updated_by, created_at, updated_at)
  VALUES
    (
      'medication_reconciliation',
      'Medication Reconciliation',
      'Medication reconciliation pilot evidence smoke module',
      true,
      false,
      '{"risk":"high","approvalPolicy":"two_person_for_enablement","reviewRoles":["DOCTOR","PHARMACIST"]}'::jsonb,
      '$reviewerSql'::uuid,
      NOW(),
      NOW()
    ),
    (
      'patient_aftercare_instructions',
      'Patient Aftercare Instructions',
      'Patient aftercare pilot evidence smoke module',
      true,
      false,
      '{"risk":"medium","reviewRoles":["DOCTOR","NURSING_STAFF"]}'::jsonb,
      '$reviewerSql'::uuid,
      NOW(),
      NOW()
    )
  ON CONFLICT (module_key) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        enabled = true,
        external_allowed = false,
        settings = EXCLUDED.settings,
        updated_by = '$reviewerSql'::uuid,
        updated_at = NOW()
  RETURNING module_key
),
seed_tenant_modules AS (
  INSERT INTO clinical_ai_tenant_modules (tenant_id, module_key, enabled, external_allowed, settings, updated_by, created_at, updated_at)
  VALUES
    (
      '$tenantSql'::uuid,
      'medication_reconciliation',
      true,
      false,
      '{"pilot_stage":"ci_first_pilot_smoke","risk":"high","approvalPolicy":"two_person_for_enablement"}'::jsonb,
      '$reviewerSql'::uuid,
      NOW(),
      NOW()
    ),
    (
      '$tenantSql'::uuid,
      'patient_aftercare_instructions',
      true,
      false,
      '{"pilot_stage":"ci_first_pilot_smoke","risk":"medium"}'::jsonb,
      '$reviewerSql'::uuid,
      NOW(),
      NOW()
    )
  ON CONFLICT (tenant_id, module_key) DO UPDATE
    SET enabled = true,
        external_allowed = false,
        settings = EXCLUDED.settings,
        updated_by = '$reviewerSql'::uuid,
        updated_at = NOW()
  RETURNING module_key
),
med_gen AS (
  INSERT INTO clinical_ai_generations (
    tenant_id, patient_uid, task_type, provider, model, prompt_version, status,
    used_ai, safety_flags, citations, draft, generated_by, reviewed_by, module_key,
    total_tokens, latency_ms, metadata, created_at, updated_at
  )
  VALUES (
    '$tenantSql'::uuid,
    '$patientSql'::uuid,
    'medication_reconciliation',
    'openai',
    'gpt-4.1-mini',
    'ci-pilot-smoke-v1',
    'reviewed',
    true,
    '[]'::jsonb,
    '[{"source":"ci-smoke","label":"MAR plus discharge summary"}]'::jsonb,
    '{"redacted":true,"summary":"CI smoke draft body must not be exported"}'::jsonb,
    '$reviewerSql'::uuid,
    '$reviewerSql'::uuid,
    'medication_reconciliation',
    128,
    900,
    jsonb_build_object(
      'smoke_name', '$smokeSql',
      'pilot_stage', '$stageSql',
      'generation_mode', 'ai',
      'provider_status', 'available'
    ),
    '$evidenceAtIso'::timestamptz,
    '$evidenceAtIso'::timestamptz
  )
  RETURNING id
),
aftercare_gen AS (
  INSERT INTO clinical_ai_generations (
    tenant_id, patient_uid, task_type, provider, model, prompt_version, status,
    used_ai, safety_flags, citations, draft, generated_by, reviewed_by, module_key,
    total_tokens, latency_ms, metadata, created_at, updated_at
  )
  VALUES (
    '$tenantSql'::uuid,
    '$patientSql'::uuid,
    'patient_aftercare_instructions',
    'template',
    NULL,
    'ci-pilot-smoke-v1',
    'reviewed',
    false,
    '[]'::jsonb,
    '[{"source":"ci-smoke","label":"signed discharge instructions"}]'::jsonb,
    '{"redacted":true,"summary":"CI smoke fallback draft body must not be exported"}'::jsonb,
    '$reviewerSql'::uuid,
    '$reviewerSql'::uuid,
    'patient_aftercare_instructions',
    0,
    40,
    jsonb_build_object(
      'smoke_name', '$smokeSql',
      'pilot_stage', '$stageSql',
      'generation_mode', 'template_fallback',
      'fallback_reason', 'provider_disabled_for_patient_facing_text',
      'readiness_reason', 'fallback_visible_to_reviewer'
    ),
    '$evidenceAtIso'::timestamptz,
    '$evidenceAtIso'::timestamptz
  )
  RETURNING id
),
seed_reviews AS (
  INSERT INTO clinical_ai_reviews (
    generation_id, module_key, patient_uid, reviewer_uid, reviewer_role, decision,
    edited_draft, reviewer_note, metadata, created_at, updated_at, tenant_id
  )
  SELECT
    med_gen.id,
    'medication_reconciliation',
    '$patientSql'::uuid,
    '$reviewerSql'::uuid,
    'PHARMACIST',
    'accepted',
    '{"redacted":true}'::jsonb,
    'Medication reconciliation pilot smoke reviewed by pharmacist with source citations checked.',
    jsonb_build_object('smoke_name', '$smokeSql', 'pilot_stage', '$stageSql'),
    '$evidenceAtIso'::timestamptz,
    '$evidenceAtIso'::timestamptz,
    '$tenantSql'::uuid
  FROM med_gen
  UNION ALL
  SELECT
    aftercare_gen.id,
    'patient_aftercare_instructions',
    '$patientSql'::uuid,
    '$reviewerSql'::uuid,
    'NURSING_STAFF',
    'edited',
    '{"redacted":true}'::jsonb,
    'Aftercare fallback pilot smoke edited and signed by nursing reviewer before release.',
    jsonb_build_object('smoke_name', '$smokeSql', 'pilot_stage', '$stageSql'),
    '$evidenceAtIso'::timestamptz,
    '$evidenceAtIso'::timestamptz,
    '$tenantSql'::uuid
  FROM aftercare_gen
  RETURNING id
),
seed_safety AS (
  INSERT INTO clinical_ai_safety_reviews (
    generation_id, module_key, status, findings, citation_coverage_pct, created_at, tenant_id
  )
  SELECT
    med_gen.id,
    'medication_reconciliation',
    'passed',
    '[]'::jsonb,
    100,
    '$evidenceAtIso'::timestamptz,
    '$tenantSql'::uuid
  FROM med_gen
  UNION ALL
  SELECT
    aftercare_gen.id,
    'patient_aftercare_instructions',
    'passed',
    '[]'::jsonb,
    100,
    '$evidenceAtIso'::timestamptz,
    '$tenantSql'::uuid
  FROM aftercare_gen
  RETURNING id
),
seed_eval AS (
  INSERT INTO clinical_ai_model_eval_runs (
    tenant_id, model_key, version, suite, generation_id, sample_count, pass_count, fail_count,
    accuracy, f1_score, avg_latency_ms, fallback_rate_pct, safety_flag_rate_pct, drift_score,
    recommendation, severity, signals, summary, recommended_actions, source_citations,
    safety_flags, reviewer_decision, reviewed_by, reviewed_at, reviewer_note, metadata,
    created_at, updated_at
  )
  SELECT
    '$tenantSql'::uuid,
    'medication_reconciliation',
    'ci-pilot-smoke-v1',
    'ci-first-pilot-evidence',
    med_gen.id,
    12,
    12,
    0,
    1.0,
    1.0,
    120,
    0,
    0,
    0,
    'no_action',
    'low',
    '[]'::jsonb,
    'Accepted CI pilot evidence smoke eval gate for medication reconciliation.',
    '[]'::jsonb,
    '[{"source":"ci-smoke","label":"eval fixture"}]'::jsonb,
    '[]'::jsonb,
    'accepted',
    '$reviewerSql'::uuid,
    '$evidenceAtIso'::timestamptz,
    'Eval gate reviewed and accepted for medication reconciliation pilot smoke.',
    jsonb_build_object(
      'smoke_name', '$smokeSql',
      'pilot_stage', '$stageSql',
      'module_key', 'medication_reconciliation'
    ),
    '$evidenceAtIso'::timestamptz,
    '$evidenceAtIso'::timestamptz
  FROM med_gen
  RETURNING id
),
seed_audit AS (
  INSERT INTO audit_logs (uid, role, action, resource, resource_id, metadata, created_at)
  VALUES (
    '$reviewerSql'::uuid,
    'ADMIN',
    'CLINICAL_AI_REVIEW_UPDATED',
    'clinical_ai',
    'ci-pilot-evidence-smoke',
    jsonb_build_object(
      'tenant_id', '$tenantSql',
      'smoke_name', '$smokeSql',
      'pilot_stage', '$stageSql',
      'module_keys', jsonb_build_array('medication_reconciliation', 'patient_aftercare_instructions')
    ),
    '$evidenceAtIso'::timestamp
  )
  RETURNING id
)
SELECT
  (SELECT id FROM med_gen)::text || '|' ||
  (SELECT id FROM aftercare_gen)::text || '|' ||
  (SELECT COUNT(*) FROM seed_reviews)::text || '|' ||
  (SELECT COUNT(*) FROM seed_safety)::text || '|' ||
  (SELECT COUNT(*) FROM seed_eval)::text || '|' ||
  (SELECT COUNT(*) FROM seed_audit)::text;
"@

$seedOutput = Invoke-Psql $seedSql
$seedParts = $seedOutput -split "\|"
if ($seedParts.Count -lt 6) {
  throw "Unexpected seed output: $seedOutput"
}

$script:AdminToken = New-SmokeToken -Uid $ReviewerUid -Role "ADMIN" -TokenTenantId $TenantId
$results = [System.Collections.Generic.List[object]]::new()

Add-ContractResult $results "seed_medication_generation" (-not [string]::IsNullOrWhiteSpace($seedParts[0])) "generationId=$($seedParts[0])"
Add-ContractResult $results "seed_aftercare_generation" (-not [string]::IsNullOrWhiteSpace($seedParts[1])) "generationId=$($seedParts[1])"
Add-ContractResult $results "seed_final_reviews" ([int]$seedParts[2] -eq 2) "reviews=$($seedParts[2])"
Add-ContractResult $results "seed_safety_reviews" ([int]$seedParts[3] -eq 2) "safetyReviews=$($seedParts[3])"
Add-ContractResult $results "seed_eval_gate" ([int]$seedParts[4] -eq 1) "evalRuns=$($seedParts[4])"
Add-ContractResult $results "seed_audit_trail" ([int]$seedParts[5] -eq 1) "auditEvents=$($seedParts[5])"

$response = Invoke-SmokeRequest $results "pilot_evidence_pack_export" "POST" "/api/v1/admin/clinical-ai/pilot-evidence-pack" @{
  pilot_stage = $PilotStage
  module_keys = $PilotModules
  from = $windowFrom
  to = $windowTo
  min_reviewed_per_module = 1
} -ExpectedStatus 201

$json = Get-JsonContent $response
$pack = Get-JsonProperty $json "data"
$summary = Get-JsonProperty $pack "summary"
$sections = Get-JsonProperty $pack "sections"
$blockers = @((Get-JsonProperty $summary "blockers"))
$skippedSections = Get-JsonProperty $summary "skipped_sections"
$moduleSummary = @((Get-JsonProperty $summary "module_summary"))
$generationCounts = Get-JsonProperty $summary "generation_counts"
$generationModeCounts = Get-JsonProperty $generationCounts "by_mode"
$reviewCounts = Get-JsonProperty $summary "review_counts"
$evalCounts = Get-JsonProperty $summary "eval_counts"
$auditCounts = Get-JsonProperty $summary "audit_counts"
$generations = @((Get-JsonProperty $sections "generations"))
$reviews = @((Get-JsonProperty $sections "reviews"))

$packVersion = Get-JsonProperty $pack "pack_version"
$pilotReady = Get-JsonProperty $summary "pilot_ready"
$tenantFromPack = Get-JsonProperty $pack "tenant_id"
$decisionSupportOnly = Get-JsonProperty $pack "decision_support_only"
$humanReviewRequired = Get-JsonProperty $pack "human_review_required"
$aiCount = Get-JsonProperty $generationModeCounts "ai"
$fallbackCount = Get-JsonProperty $generationModeCounts "template_fallback"
$finalReviewCount = Get-JsonProperty $reviewCounts "final_review_count"
$finalReviewsMissingNotes = Get-JsonProperty $reviewCounts "final_reviews_missing_note_count"
$acceptedEvalCount = Get-JsonProperty $evalCounts "accepted"
$auditTotal = Get-JsonProperty $auditCounts "total"
$skippedCount = if ($null -eq $skippedSections) { 0 } else { @($skippedSections.PSObject.Properties).Count }
$allModulesReady = $moduleSummary.Count -eq 2 -and @($moduleSummary | Where-Object {
  (Get-JsonProperty $_ "effective_enabled") -eq $true `
    -and (Get-JsonProperty $_ "generation_count") -ge 1 `
    -and (Get-JsonProperty $_ "final_review_requirement_met") -eq $true `
    -and (Get-JsonProperty $_ "final_reviews_missing_note_count") -eq 0
}).Count -eq 2
$riskModuleEvalReady = @($moduleSummary | Where-Object {
  (Get-JsonProperty $_ "module_key") -eq "medication_reconciliation" `
    -and (Get-JsonProperty $_ "risky") -eq $true `
    -and (Get-JsonProperty $_ "accepted_eval_count") -ge 1
}).Count -eq 1
$generationDraftLeaked = @($generations | Where-Object { Has-JsonProperty $_ "draft" }).Count -gt 0
$reviewNoteLeaked = @($reviews | Where-Object { Has-JsonProperty $_ "reviewer_note" }).Count -gt 0

Add-ContractResult $results "pack_version_contract" ($packVersion -eq "clinical-ai-pilot-evidence-pack-v1") "packVersion=$packVersion"
Add-ContractResult $results "pack_tenant_isolated" ($tenantFromPack -eq $TenantId) "tenantId=$tenantFromPack"
Add-ContractResult $results "pack_decision_support_only" ($decisionSupportOnly -eq $true -and $humanReviewRequired -eq $true) "decisionSupport=$decisionSupportOnly humanReview=$humanReviewRequired"
Add-ContractResult $results "pack_pilot_ready" ($pilotReady -eq $true -and $blockers.Count -eq 0) "pilotReady=$pilotReady blockers=$($blockers.Count)"
Add-ContractResult $results "pack_no_skipped_sections" ($skippedCount -eq 0) "skippedSections=$skippedCount"
Add-ContractResult $results "pack_module_summary_ready" $allModulesReady "modules=$($moduleSummary.Count)"
Add-ContractResult $results "pack_risky_module_eval_gated" $riskModuleEvalReady "acceptedEval=$acceptedEvalCount"
Add-ContractResult $results "pack_generation_labels" (($aiCount -ge 1) -and ($fallbackCount -ge 1)) "ai=$aiCount fallback=$fallbackCount"
Add-ContractResult $results "pack_human_review_notes_gate" (($finalReviewCount -ge 2) -and ($finalReviewsMissingNotes -eq 0)) "finalReviews=$finalReviewCount missingNotes=$finalReviewsMissingNotes"
Add-ContractResult $results "pack_audit_trail_present" ($auditTotal -ge 1) "auditEvents=$auditTotal"
Add-ContractResult $results "pack_redacts_generation_drafts" (-not $generationDraftLeaked) "generationRows=$($generations.Count)"
Add-ContractResult $results "pack_redacts_reviewer_notes" (-not $reviewNoteLeaked) "reviewRows=$($reviews.Count)"

$signoffResponse = Invoke-SmokeRequest $results "pilot_signoff_create" "POST" "/api/v1/admin/clinical-ai/pilot-signoffs" @{
  pilot_stage = $PilotStage
  module_keys = $PilotModules
  from = $windowFrom
  to = $windowTo
  min_reviewed_per_module = 1
  reason = "CI pilot evidence smoke signoff request"
} -ExpectedStatus 201

$signoffJson = Get-JsonContent $signoffResponse
$signoffData = Get-JsonProperty $signoffJson "data"
$signoff = Get-JsonProperty $signoffData "signoff"
$signoffPack = Get-JsonProperty $signoffData "evidence_pack"
$signoffId = Get-JsonProperty $signoff "id"
$signoffStatus = Get-JsonProperty $signoff "status"
$signoffPilotReady = Get-JsonProperty $signoff "pilot_ready"
$signoffHash = Get-JsonProperty $signoff "pack_hash"
$signoffGateAllowed = Get-JsonProperty $signoff "stage_expansion_allowed"
$signoffPackSummary = Get-JsonProperty $signoffPack "summary"

Add-ContractResult $results "signoff_created_pending" (($signoffStatus -eq "pending") -and ($signoffId -gt 0)) "id=$signoffId status=$signoffStatus"
Add-ContractResult $results "signoff_pilot_ready_snapshot" (($signoffPilotReady -eq $true) -and ((Get-JsonProperty $signoffPackSummary "pilot_ready") -eq $true)) "pilotReady=$signoffPilotReady"
Add-ContractResult $results "signoff_hash_recorded" (-not [string]::IsNullOrWhiteSpace([string]$signoffHash)) "hash=$signoffHash"
Add-ContractResult $results "signoff_blocks_until_decided" ($signoffGateAllowed -eq $false) "stageExpansionAllowed=$signoffGateAllowed"

$decisionResponse = Invoke-SmokeRequest $results "pilot_signoff_approve" "PATCH" "/api/v1/admin/clinical-ai/pilot-signoffs/$signoffId" @{
  decision = "approved"
  reason = "CI clinical lead approves pilot evidence for stage expansion"
} -ExpectedStatus 200

$decisionJson = Get-JsonContent $decisionResponse
$approvedSignoff = Get-JsonProperty $decisionJson "data"
$approvedStatus = Get-JsonProperty $approvedSignoff "status"
$approvedGateAllowed = Get-JsonProperty $approvedSignoff "stage_expansion_allowed"
$approvedBlockingReason = Get-JsonProperty $approvedSignoff "blocking_reason"

Add-ContractResult $results "signoff_approved" ($approvedStatus -eq "approved") "status=$approvedStatus"
Add-ContractResult $results "signoff_opens_expansion_gate" (($approvedGateAllowed -eq $true) -and ($null -eq $approvedBlockingReason)) "stageExpansionAllowed=$approvedGateAllowed blockingReason=$approvedBlockingReason"

$encodedStage = [System.Uri]::EscapeDataString($PilotStage)
$encodedModules = [System.Uri]::EscapeDataString(($PilotModules -join ","))
$gateResponse = Invoke-SmokeRequest $results "pilot_signoff_gate" "GET" "/api/v1/admin/clinical-ai/pilot-signoffs/gate?pilot_stage=$encodedStage&module_keys=$encodedModules" -ExpectedStatus 200
$gateJson = Get-JsonContent $gateResponse
$gate = Get-JsonProperty $gateJson "data"
$gateAllowed = Get-JsonProperty $gate "stage_expansion_allowed"
$gateLatest = Get-JsonProperty $gate "latest_signoff"
$gateLatestStatus = Get-JsonProperty $gateLatest "status"

Add-ContractResult $results "gate_reads_approved_signoff" (($gateAllowed -eq $true) -and ($gateLatestStatus -eq "approved")) "stageExpansionAllowed=$gateAllowed latest=$gateLatestStatus"

$results | Format-Table -AutoSize

$failed = @($results | Where-Object { -not $_.ok })
if ($failed.Count -gt 0) {
  Write-Error "Clinical AI pilot evidence smoke failed: $($failed.Count) check(s) failed."
  exit 1
}

Write-Host "Clinical AI pilot evidence smoke passed: $($results.Count) check(s)."
