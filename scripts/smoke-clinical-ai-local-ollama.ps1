<#
.SYNOPSIS
Runs a Clinical AI local-Ollama deep-tier smoke against the backend.

.DESCRIPTION
Seeds a disposable medication-reconciliation admission, calls the real EMR
workflow route, and proves the generated clinical_ai_generations row is visibly
labelled as deep-tier local Ollama output. The backend must be started with:

  CLINICAL_AI_DEEP_PROVIDER=ollama
  CLINICAL_AI_DEEP_BASE_URL=http://127.0.0.1:<MockOllamaPort>
  CLINICAL_AI_DEEP_MODEL=<DeepModel>
  CLINICAL_AI_ALLOW_EXTERNAL=false
#>
[CmdletBinding()]
param(
  [string]$BackendBase = "http://127.0.0.1:5206",
  [string]$BackendDir = "",
  [string]$TenantId = "00000000-0000-4000-8000-000000000001",
  [string]$ReviewerUid = "88888888-8888-4888-8888-888888888888",
  [string]$PatientUid = "55555555-5555-4555-8555-555555555556",
  [int]$AdmissionId = 991206,
  [string]$JwtSecret = "vhhealth-local-admin-smoke-secret-123456789",
  [string]$ApiKey = "vhhealth-local-api-key",
  [string]$PgHost = "127.0.0.1",
  [int]$PgPort = 55432,
  [string]$PgUser = "postgres",
  [string]$PgDatabase = "vhhealth_test",
  [string]$PgPassword = "",
  [string]$PsqlPath = "psql",
  [int]$MockOllamaPort = 11534,
  [string]$DeepModel = "llama3.1:70b-instruct-q4_K_M"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SmokeName = "clinical_ai_local_ollama_deep_tier"
$ModuleKey = "medication_reconciliation"

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
  email: `${uid}@clinical-ai-local-ollama-smoke.local`
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

function Add-ContractResult {
  param(
    [System.Collections.Generic.List[object]]$Results,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][bool]$Ok,
    [string]$Detail = ""
  )

  $status = if ($Ok) { "PASS" } else { "FAIL" }
  Add-Result $Results $Name $status $Ok $Detail
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

    $response = Invoke-WebRequest @params
    $ok = if ($ExpectedStatus -gt 0) {
      [int]$response.StatusCode -eq $ExpectedStatus
    } else {
      $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    }
    Add-Result $Results $Name ([int]$response.StatusCode) $ok ""
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
  try {
    return $Response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-JsonProperty {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Start-MockOllama {
  param([int]$Port, [string]$Model)

  $serverPath = Join-Path ([System.IO.Path]::GetTempPath()) "vh-local-ollama-smoke-$Port.js"
  $serverScript = @"
const http = require('http');
let generateHits = 0;
const model = '$($Model.Replace("'", "\\'"))';
const draft = {
  continue: [{ medication: 'amlodipine', dose: '5 mg', rationale: 'Continue documented home antihypertensive pending clinician review.' }],
  stop: [],
  change: [],
  safety_flags: [],
  source_citations: [{ source_type: 'admission', source_id: String($AdmissionId), label: 'Smoke admission chart packet' }]
};
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: model }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/__hits') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ generateHits }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      generateHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: JSON.stringify(draft),
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 31,
        eval_count: 19,
        total_duration: 420000000
      }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});
server.listen($Port, '127.0.0.1', () => {
  console.log('mock-ollama-ready:' + $Port);
});
"@
  Set-Content -LiteralPath $serverPath -Value $serverScript -Encoding ASCII
  $startParams = @{
    FilePath = "node"
    ArgumentList = @($serverPath)
    PassThru = $true
  }
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $startParams.WindowStyle = "Hidden"
  }
  $process = Start-Process @startParams
  Start-Sleep -Milliseconds 750
  return [pscustomobject]@{ Process = $process; Path = $serverPath }
}

Assert-Command "node"
Assert-Command $PsqlPath

. (Join-Path $PSScriptRoot "lib/smoke-results.ps1")

$results = [System.Collections.Generic.List[object]]::new()

try {
$mockServer = $null

try {
  $mockServer = Start-MockOllama -Port $MockOllamaPort -Model $DeepModel

  $tenantSql = Escape-SqlText $TenantId
  $reviewerSql = Escape-SqlText $ReviewerUid
  $patientSql = Escape-SqlText $PatientUid
  $moduleSql = Escape-SqlText $ModuleKey
  $smokeSql = Escape-SqlText $SmokeName

  $seedSql = @"
WITH old_safety AS (
  DELETE FROM clinical_ai_safety_reviews sr
  USING clinical_ai_generations g
  WHERE sr.generation_id = g.id
    AND g.tenant_id = '$tenantSql'::uuid
    AND g.admission_id = $AdmissionId
  RETURNING sr.id
),
old_reviews AS (
  DELETE FROM clinical_ai_reviews r
  USING clinical_ai_generations g
  WHERE r.generation_id = g.id
    AND g.tenant_id = '$tenantSql'::uuid
    AND g.admission_id = $AdmissionId
  RETURNING r.id
),
old_generations AS (
  DELETE FROM clinical_ai_generations
  WHERE tenant_id = '$tenantSql'::uuid
    AND admission_id = $AdmissionId
  RETURNING id
),
old_runs AS (
  DELETE FROM clinical_ai_workflow_runs
  WHERE tenant_id = '$tenantSql'::uuid
    AND admission_id = '$AdmissionId'
  RETURNING id
),
old_snapshots AS (
  DELETE FROM clinical_ai_context_snapshots
  WHERE tenant_id = '$tenantSql'::uuid
    AND admission_id = '$AdmissionId'
  RETURNING id
),
old_admission AS (
  DELETE FROM admissions
  WHERE id = $AdmissionId
  RETURNING id
),
seed_tenant AS (
  INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
  VALUES ('$tenantSql'::uuid, 'default', 'VH Health Default Tenant', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET status = 'active', region = 'IN', updated_at = NOW()
  RETURNING id
),
seed_guardrails AS (
  INSERT INTO clinical_ai_guardrails (id, enabled, external_ai_enabled, fallback_rate_alert_pct, latency_alert_ms, updated_by, created_at, updated_at)
  VALUES (1, true, true, 50, 15000, '$reviewerSql'::uuid, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
    SET enabled = true,
        external_ai_enabled = true,
        updated_by = '$reviewerSql'::uuid,
        updated_at = NOW()
  RETURNING id
),
seed_reviewer AS (
  INSERT INTO users (uid, phone, name, email, role, is_active, status, tenant_id, updated_at)
  VALUES ('$reviewerSql'::uuid, '7999001206', 'Local Ollama Smoke Doctor', 'local-ollama-doctor@example.test', 'DOCTOR', true, 'active', '$tenantSql'::uuid, NOW())
  ON CONFLICT (uid) DO UPDATE
    SET role = 'DOCTOR',
        is_active = true,
        status = 'active',
        tenant_id = '$tenantSql'::uuid,
        updated_at = NOW()
  RETURNING uid
),
seed_patient AS (
  INSERT INTO users (uid, phone, name, email, role, is_active, status, tenant_id, gender, birthday, chronic_medications, chronic_medications_updated_at, updated_at)
  VALUES (
    '$patientSql'::uuid,
    '7999001207',
    'Local Ollama Smoke Patient',
    'local-ollama-patient@example.test',
    'PATIENT',
    true,
    'active',
    '$tenantSql'::uuid,
    'female',
    '1978-03-14',
    '[{"name":"amlodipine","dose":"5 mg","frequency":"OD"}]'::jsonb,
    NOW(),
    NOW()
  )
  ON CONFLICT (uid) DO UPDATE
    SET is_active = true,
        status = 'active',
        tenant_id = '$tenantSql'::uuid,
        chronic_medications = EXCLUDED.chronic_medications,
        chronic_medications_updated_at = NOW(),
        updated_at = NOW()
  RETURNING uid
),
seed_admission AS (
  -- admitting_doctor/attending_doctor MUST be the reviewer: a DOCTOR-role actor
  -- is scoped to their OWN patients (ownDoctorWhere = admitting/attending = uid)
  -- by resolveInpatientAdmissionScope, so getAdmissionDetail 404s for an
  -- admission this doctor is not assigned to. Without this the deep-tier route
  -- returns "Admission not found" before any AI generation runs.
  INSERT INTO admissions (id, patient_uid, status, department, ward, bed_number, chief_complaint, admitting_diagnosis, admission_type, admitting_doctor, attending_doctor, admitted_at, created_at, updated_at)
  VALUES ($AdmissionId, '$patientSql'::uuid, 'admitted', 'General Medicine', 'Ward A', 'A-12', 'Hypertension review before discharge', 'Hypertension with medication reconciliation pending', 'inpatient', '$reviewerSql'::uuid, '$reviewerSql'::uuid, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NOW())
  ON CONFLICT (id) DO UPDATE
    SET patient_uid = '$patientSql'::uuid,
        status = 'admitted',
        department = 'General Medicine',
        ward = 'Ward A',
        bed_number = 'A-12',
        chief_complaint = 'Hypertension review before discharge',
        admitting_diagnosis = 'Hypertension with medication reconciliation pending',
        admission_type = 'inpatient',
        admitting_doctor = '$reviewerSql'::uuid,
        attending_doctor = '$reviewerSql'::uuid,
        admitted_at = NOW() - INTERVAL '1 day',
        updated_at = NOW()
  RETURNING id
),
seed_module AS (
  INSERT INTO clinical_ai_modules (module_key, display_name, description, enabled, external_allowed, settings, updated_by, created_at, updated_at)
  VALUES (
    '$moduleSql',
    'Medication Reconciliation',
    'Medication reconciliation local Ollama smoke module',
    true,
    false,
    '{"risk":"critical","model_tier":"deep","approvalPolicy":"two_person_for_enablement","requiresClinicianSignoff":true,"requiresCitations":true,"reviewRoles":["DOCTOR","PHARMACY_STAFF"]}'::jsonb,
    '$reviewerSql'::uuid,
    NOW(),
    NOW()
  )
  ON CONFLICT (module_key) DO UPDATE
    SET enabled = true,
        external_allowed = false,
        settings = EXCLUDED.settings,
        updated_by = '$reviewerSql'::uuid,
        updated_at = NOW()
  RETURNING module_key
),
seed_tenant_module AS (
  INSERT INTO clinical_ai_tenant_modules (tenant_id, module_key, enabled, external_allowed, settings, updated_by, created_at, updated_at)
  VALUES (
    '$tenantSql'::uuid,
    '$moduleSql',
    true,
    false,
    '{"smoke_name":"$smokeSql","risk":"critical","model_tier":"deep","requiresClinicianSignoff":true,"requiresCitations":true}'::jsonb,
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
)
SELECT 'seeded';
"@
  Invoke-Psql $seedSql | Out-Null
  Add-ContractResult $results "seed_deep_tier_admission" $true "admission=$AdmissionId module=$ModuleKey"

  $script:AdminToken = New-SmokeToken -Uid $ReviewerUid -Role "DOCTOR" -TokenTenantId $TenantId
  $response = Invoke-SmokeRequest $results "generate_med_reconciliation" "POST" "/api/v1/emr/$AdmissionId/medication-reconciliation" $null -ExpectedStatus 200
  $json = Get-JsonContent $response
  $data = Get-JsonProperty $json "data"
  $aiMetadata = Get-JsonProperty $data "ai_metadata"

  $apiProvider = Get-JsonProperty $aiMetadata "provider"
  $apiTier = Get-JsonProperty $aiMetadata "tier"
  $apiModel = Get-JsonProperty $aiMetadata "model"
  $apiMode = Get-JsonProperty $aiMetadata "generation_mode"
  $apiProviderStatus = Get-JsonProperty $aiMetadata "provider_status"
  $apiUsedAi = Get-JsonProperty $aiMetadata "used_ai"

  Add-ContractResult $results "api_labels_local_ollama" (($apiProvider -eq "ollama") -and ($apiTier -eq "deep") -and ($apiModel -eq $DeepModel)) "provider=$apiProvider tier=$apiTier model=$apiModel"
  Add-ContractResult $results "api_labels_ai_used" (($apiUsedAi -eq $true) -and ($apiMode -eq "ai") -and ($apiProviderStatus -eq "used")) "usedAi=$apiUsedAi mode=$apiMode providerStatus=$apiProviderStatus"

  $reviewsResponse = Invoke-SmokeRequest $results "review_queue_fetch" "GET" "/api/v1/clinical-ai/clinical/reviews?decision=pending&module_key=$ModuleKey&limit=20" $null -ExpectedStatus 200
  $reviewsJson = Get-JsonContent $reviewsResponse
  $reviewsData = Get-JsonProperty $reviewsJson "data"
  $reviews = Get-JsonProperty $reviewsData "reviews"
  $reviewMatches = @($reviews | Where-Object { $_.admission_id -eq $AdmissionId } | Select-Object -First 1)
  $review = if ($reviewMatches.Count -gt 0) { $reviewMatches[0] } else { $null }
  $reviewProvider = Get-JsonProperty $review "provider"
  $reviewTier = Get-JsonProperty $review "tier"
  $reviewMode = Get-JsonProperty $review "generation_mode"
  $reviewProviderStatus = Get-JsonProperty $review "provider_status"
  $reviewUsedAi = Get-JsonProperty $review "used_ai"
  $reviewDraft = Get-JsonProperty $review "draft"
  $reviewCitations = Get-JsonProperty $review "citations"

  Add-ContractResult $results "review_queue_labels_visible" (($reviewProvider -eq "ollama") -and ($reviewTier -eq "deep") -and ($reviewUsedAi -eq $true) -and ($reviewMode -eq "ai") -and ($reviewProviderStatus -eq "used")) "provider=$reviewProvider tier=$reviewTier usedAi=$reviewUsedAi mode=$reviewMode providerStatus=$reviewProviderStatus"
  Add-ContractResult $results "review_queue_draft_available" (($null -ne $reviewDraft) -and ($null -ne $reviewCitations)) "draft=$($null -ne $reviewDraft) citations=$($null -ne $reviewCitations)"

  $hitsJson = Invoke-WebRequest -Uri "http://127.0.0.1:$MockOllamaPort/__hits" -Method GET
  $hits = (($hitsJson.Content | ConvertFrom-Json).generateHits)
  Add-ContractResult $results "mock_ollama_invoked" ($hits -ge 1) "generateHits=$hits"

  $rowSql = @"
SELECT concat_ws('|',
  provider,
  COALESCE(model, ''),
  COALESCE(metadata->>'tier', ''),
  COALESCE(metadata->>'model_tier', ''),
  COALESCE(metadata->>'generation_mode', ''),
  COALESCE(metadata->>'provider_status', ''),
  used_ai::text,
  COALESCE(metadata->>'output_defenses_ran', ''),
  COALESCE(metadata->>'no_heuristic_flags', '')
)
FROM clinical_ai_generations
WHERE tenant_id = '$tenantSql'::uuid
  AND admission_id = $AdmissionId
  AND module_key = '$moduleSql'
ORDER BY created_at DESC, id DESC
LIMIT 1;
"@
  $row = Invoke-Psql $rowSql
  $parts = @($row -split '\|')
  $dbProvider = if ($parts.Length -gt 0) { $parts[0] } else { "" }
  $dbModel = if ($parts.Length -gt 1) { $parts[1] } else { "" }
  $dbTier = if ($parts.Length -gt 2) { $parts[2] } else { "" }
  $dbModelTier = if ($parts.Length -gt 3) { $parts[3] } else { "" }
  $dbMode = if ($parts.Length -gt 4) { $parts[4] } else { "" }
  $dbProviderStatus = if ($parts.Length -gt 5) { $parts[5] } else { "" }
  $dbUsedAi = if ($parts.Length -gt 6) { $parts[6] } else { "" }
  $dbOutputDefensesRan = if ($parts.Length -gt 7) { $parts[7] } else { "" }
  # Renamed from defenses_passed → no_heuristic_flags (AI-4c): "no heuristic
  # output-defense flag fired", not a safety proof. Backend writes it in
  # clinicalAiWorkflowService persist_generation metadata.
  $dbNoHeuristicFlags = if ($parts.Length -gt 8) { $parts[8] } else { "" }

  Add-ContractResult $results "db_labels_local_ollama" (($dbProvider -eq "ollama") -and ($dbModel -eq $DeepModel) -and ($dbTier -eq "deep") -and ($dbModelTier -eq "deep")) "provider=$dbProvider model=$dbModel tier=$dbTier modelTier=$dbModelTier"
  Add-ContractResult $results "db_labels_ai_used" (($dbUsedAi -eq "true") -and ($dbMode -eq "ai") -and ($dbProviderStatus -eq "used")) "usedAi=$dbUsedAi mode=$dbMode providerStatus=$dbProviderStatus"
  Add-ContractResult $results "db_output_defenses_visible" (($dbOutputDefensesRan -eq "true") -and ($dbNoHeuristicFlags -eq "true")) "outputDefensesRan=$dbOutputDefensesRan noHeuristicFlags=$dbNoHeuristicFlags"
} finally {
  if ($null -ne $mockServer) {
    try {
      Stop-Process -Id $mockServer.Process.Id -Force -ErrorAction SilentlyContinue
    } catch {}
    try {
      Remove-Item -LiteralPath $mockServer.Path -Force -ErrorAction SilentlyContinue
    } catch {}
  }
}

Write-SmokeResults $results
$failed = @($results | Where-Object { -not $_.ok })
if ($failed.Count -gt 0) {
  throw "$($failed.Count) local Ollama smoke check(s) failed"
}

Write-Host "Clinical AI local Ollama deep-tier smoke passed ($($results.Count) checks)."
} finally {
  # A terminating error above must not discard the checks already recorded.
  # Write-SmokeResults is idempotent, so the normal path prints where it
  # always did and this is a no-op after it.
  Write-SmokeResults $results
}
