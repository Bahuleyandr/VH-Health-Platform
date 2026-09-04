<#
.SYNOPSIS
Runs a local staff clinical-safety API smoke matrix against the backend.

.DESCRIPTION
Assumes the local backend and Postgres smoke database are already running. The
script applies the idempotent clinical-safety alignment migration, seeds
disposable staff/patient data, and exercises CDS allergy blocking end to end,
plus a probe proving the retired direct MAR-schedule route is still closed.

MAR 5-rights is NOT exercised here. It moved to src/tests/clinical-safety.test.js
(service layer) and src/tests/governed-order-mar-http.deep.test.js (HTTP layer)
when PR #940 put dose creation behind the governed clinical-order workflow.
#>
[CmdletBinding()]
param(
  [string]$BackendBase = "http://127.0.0.1:5206",
  [string]$BackendDir = "",
  [string]$StaffUid = "77777777-7777-4777-8777-777777777777",
  [string]$PatientUid = "66666666-6666-4666-8666-666666666666",
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

function Invoke-Psql {
  param([Parameter(Mandatory)][string]$Sql)

  $previousPassword = $env:PGPASSWORD
  $env:PGPASSWORD = $PgPassword
  try {
    $output = & $PsqlPath -qAt -h $PgHost -p $PgPort -U $PgUser -d $PgDatabase -c $Sql
    if ($LASTEXITCODE -ne 0) {
      throw "psql exited with code $LASTEXITCODE"
    }
    return (($output | Out-String).Trim())
  } finally {
    $env:PGPASSWORD = $previousPassword
  }
}

function Invoke-PsqlFile {
  param([Parameter(Mandatory)][string]$Path)

  $previousPassword = $env:PGPASSWORD
  $previousPgOptions = $env:PGOPTIONS
  $env:PGPASSWORD = $PgPassword
  $env:PGOPTIONS = "-c client_min_messages=warning"
  try {
    & $PsqlPath -q -v ON_ERROR_STOP=1 -h $PgHost -p $PgPort -U $PgUser -d $PgDatabase -f $Path | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "psql -f exited with code $LASTEXITCODE for $Path"
    }
  } finally {
    $env:PGPASSWORD = $previousPassword
    $env:PGOPTIONS = $previousPgOptions
  }
}

function New-SmokeToken {
  param(
    [Parameter(Mandatory)][string]$Uid,
    [Parameter(Mandatory)][string]$Role
  )

  $previousSecret = $env:SMOKE_JWT_SECRET
  $previousUid = $env:SMOKE_UID
  $previousRole = $env:SMOKE_ROLE
  $env:SMOKE_JWT_SECRET = $JwtSecret
  $env:SMOKE_UID = $Uid
  $env:SMOKE_ROLE = $Role

  try {
    Push-Location $BackendDir
    try {
      $script = @'
const jwt = require('jsonwebtoken');
const uid = process.env.SMOKE_UID;
const role = process.env.SMOKE_ROLE;
console.log(jwt.sign({
  uid,
  sub: uid,
  role,
  email: `${uid}@clinical-safety-smoke.local`
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
    [string]$AuthToken = $script:StaffToken,
    [int]$ExpectedStatus = 0
  )

  $uri = "$($BackendBase.TrimEnd('/'))$Path"
  $headers = @{
    Authorization = "Bearer $AuthToken"
    "x-api-key" = $ApiKey
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

Assert-Command "node"
Assert-Command $PsqlPath

$migrationCandidates = @(
  (Join-Path $BackendDir "src\migrations\033_clinical_safety_runtime_alignment.sql"),
  (Join-Path $BackendDir "migrations\033_clinical_safety_runtime_alignment.sql")
)
$migrationPath = $migrationCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($migrationPath) {
  Invoke-PsqlFile $migrationPath
} else {
  Write-Verbose "Clinical-safety runtime alignment migration not found; assuming canonical migrations already provisioned the schema."
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"

$patientId = Invoke-Psql @"
DELETE FROM cds_alerts WHERE patient_uid = '$PatientUid'::uuid;
DELETE FROM medication_administrations WHERE patient_uid = '$PatientUid'::uuid;
DELETE FROM allergies WHERE patient_uid = '$PatientUid'::uuid;
DELETE FROM patient_allergies WHERE patient_uid = '$PatientUid'::uuid;
DELETE FROM prescriptions WHERE patient_uid = '$PatientUid'::uuid;
DELETE FROM care_team_members WHERE patient_uid = '$PatientUid'::uuid;
DELETE FROM care_teams WHERE patient_uid = '$PatientUid'::uuid;

INSERT INTO users (uid, phone, name, email, role, is_active, status, updated_at)
VALUES
  ('$StaffUid'::uuid, '8811000201', 'Clinical Safety Staff $stamp', 'clinical-safety-staff-$stamp@example.test', 'NURSE', true, 'active', NOW()),
  ('$PatientUid'::uuid, '8811000202', 'Clinical Safety Patient $stamp', 'clinical-safety-patient-$stamp@example.test', 'PATIENT', true, 'active', NOW())
ON CONFLICT (uid) DO UPDATE SET
  name = EXCLUDED.name,
  email = EXCLUDED.email,
  role = EXCLUDED.role,
  is_active = true,
  status = 'active',
  updated_at = NOW();

-- Establish the nurse<->patient care-team relationship the clinical ABAC guard
-- requires. The /api/v1/clinical mount is a legacy enforce site (it is NOT
-- careTeamModeGoverned), so without an accepted relationship every MAR call
-- correctly 403s "no active care-team...". tenant_id MUST equal the value
-- deriveTenantIdFromRequest() resolves for the smoke JWT (DEFAULT_TENANT_ID),
-- since the relationship query filters care_teams/care_team_members on it.
-- team_kind MUST be 'longitudinal': findCareTeamRelationship() grants
-- context-free access (appointment_id AND admission_id both NULL) only to
-- longitudinal teams. This smoke seeds no admission, so an episode-scoped
-- kind like 'ip' would 403 every clinical call.
WITH seeded_team AS (
  INSERT INTO care_teams (tenant_id, patient_uid, team_kind, status, display_name)
  VALUES (
    '00000000-0000-4000-8000-000000000001'::uuid,
    '$PatientUid'::uuid, 'longitudinal', 'active', 'Clinical Safety Smoke Team $stamp'
  )
  RETURNING id
)
INSERT INTO care_team_members (
  tenant_id, care_team_id, patient_uid, staff_uid, staff_role, relationship_kind, status, active_from
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid, seeded_team.id, '$PatientUid'::uuid,
  '$StaffUid'::uuid, 'NURSING_STAFF', 'nurse', 'active', NOW()
FROM seeded_team;

INSERT INTO allergies (patient_uid, allergen, name, severity, reaction, status)
VALUES ('$PatientUid'::uuid, 'amoxicillin', 'Amoxicillin', 'severe', 'anaphylaxis', 'active');

INSERT INTO patient_allergies (patient_id, patient_uid, allergy_name, severity, reaction, is_active)
SELECT id, uid, 'penicillin', 'severe', 'rash', true
FROM users
WHERE uid = '$PatientUid'::uuid;

SELECT id FROM users WHERE uid = '$PatientUid'::uuid;
"@

$script:StaffToken = New-SmokeToken -Uid $StaffUid -Role "NURSING_STAFF"
. (Join-Path $PSScriptRoot "lib/smoke-results.ps1")

$results = [System.Collections.Generic.List[object]]::new()

try {
# MAR five-rights moved out of this smoke (2026-09-04).
#
# PR #940 retired POST /clinical/mar/schedule: doses are now created only as a
# post-commit side effect of the governed clinical-order workflow, and the
# drug-right resolves to "exactly the ordered catalog product and one eligible
# ward-custody batch" (services/clinical/marFiveRightsService.js#186). Re-proving
# the five rights from here would mean seeding catalog, inventory, facility,
# ward, bed, admission, a ward indent and its reserve/approve/issue/receive
# custody chain, then an order and its verification, before the first assertion
# -- coupling a clinical-safety smoke to the entire ward-supply subsystem, so
# that an inventory change reddens this file and points at the wrong subsystem.
#
# The contracts are NOT dropped. They moved to where the fixtures already exist:
#   src/tests/clinical-safety.test.js proves the five rights, the block on an
#     un-overridden failure, the SOFT-right override audit trail, and the
#     wrong-patient NON-overridable hard stop -- that last one more strictly
#     than this script ever did.
#   src/tests/governed-order-mar-http.deep.test.js proves the same surface over
#     HTTP -- routes, auth and middleware -- through the governed order path.
#
# What stays here is the one thing neither of those can see from inside the
# process: that the retired route is still closed on the running server. If it
# ever answers 2xx again, an ungoverned way back into the MAR has reopened, and
# every custody guarantee above it is bypassable.
$marClosure = Invoke-SmokeRequest $results "mar_schedule_direct_closed" "POST" "/api/v1/clinical/mar/schedule" @{
  patient_uid = $PatientUid
  prescription_id = $null
  medications = @(
    @{
      medication_name = "Paracetamol"
      dose = "500 mg"
      route = "oral"
      scheduled_time = (Get-Date).ToString("o")
      notes = "Clinical safety smoke closure probe $stamp"
    }
  )
} -ExpectedStatus 409

# Assert the REASON, not just the status. A 409 is reachable from unrelated
# conflicts; only the code proves this specific closure is what refused us.
# responseHelper.error() nests the details object under `details` (utils/
# responseHelper.js#234), so the code is details.code, not a root field.
$marClosureJson = Get-JsonContent $marClosure
$marClosureDetails = Get-JsonProperty $marClosureJson "details"
$marClosureCode = Get-JsonProperty $marClosureDetails "code"
$marClosureEndpoint = Get-JsonProperty $marClosureDetails "order_endpoint"
Add-ContractResult $results "mar_schedule_closed_contract" ($marClosureCode -eq "MAR_SCHEDULE_REQUIRES_CLINICAL_ORDER_WORKFLOW") "code=$marClosureCode"

# The refusal is only actionable if it still names the governed replacement.
Add-ContractResult $results "mar_schedule_closure_names_successor" ($marClosureEndpoint -eq "/api/v1/emr/orders") "orderEndpoint=$marClosureEndpoint"

$cds = Invoke-SmokeRequest $results "cds_check_allergy_blocker" "POST" "/api/v1/emr/cds/check-order" @{
  type = "medication"
  medication_name = "Amoxicillin"
  patient_uid = $PatientUid
  encounter_id = "ENC-SMOKE-$stamp"
}
$cdsJson = Get-JsonContent $cds
$cdsData = Get-JsonProperty $cdsJson "data"
$cdsSafe = Get-JsonProperty $cdsData "safe"
$cdsAlerts = @(Get-JsonProperty $cdsData "alerts")
$allergyAlerts = @($cdsAlerts | Where-Object { (Get-JsonProperty $_ "type") -eq "allergy" })
$allergyAlertCount = @($allergyAlerts).Count
Add-ContractResult $results "cds_check_allergy_contract" ($cdsSafe -eq $false -and $allergyAlertCount -ge 1) "safe=$cdsSafe allergyAlerts=$allergyAlertCount"

$alerts = Invoke-SmokeRequest $results "cds_active_alerts" "GET" "/api/v1/emr/cds/alerts/$PatientUid"
$alertsJson = Get-JsonContent $alerts
$rawActiveAlertsData = Get-JsonProperty $alertsJson "data"
$activeAlertsData = if ($null -ne $rawActiveAlertsData) { @($rawActiveAlertsData) } else { @() }
$activeAllergyAlert = @($activeAlertsData | Where-Object { (Get-JsonProperty $_ "alert_type") -eq "allergy" } | Select-Object -First 1)
$activeAllergyCount = @($activeAllergyAlert).Count
$activeAllergyRow = if ($activeAllergyCount -ge 1) { @($activeAllergyAlert)[0] } else { $null }
$alertId = Get-JsonProperty $activeAllergyRow "id"
Add-ContractResult $results "cds_active_alerts_contract" ($alertId -ne $null) "alertId=$alertId"

if ($alertId) {
  $ack = Invoke-SmokeRequest $results "cds_acknowledge_alert" "POST" "/api/v1/emr/cds/alerts/$alertId/acknowledge" @{
    override_reason = "Reviewed by clinical safety smoke"
  }
  $ackJson = Get-JsonContent $ack
  $ackData = Get-JsonProperty $ackJson "data"
  $acknowledged = Get-JsonProperty $ackData "acknowledged"
  $acknowledgedBy = Get-JsonProperty $ackData "acknowledged_by"
  $ackOverrideReason = Get-JsonProperty $ackData "override_reason"
  Add-ContractResult $results "cds_acknowledge_contract" ($acknowledged -eq $true -and $acknowledgedBy -eq $StaffUid -and $ackOverrideReason) "ackBy=$acknowledgedBy"
} else {
  Add-ContractResult $results "cds_acknowledge_contract" $false "alert id missing"
}

$ackCount = Invoke-Psql "SELECT COUNT(*) FROM cds_alerts WHERE patient_uid = '$PatientUid'::uuid AND alert_type = 'allergy' AND acknowledged = true AND ack_by = '$StaffUid'::uuid;"
Add-ContractResult $results "cds_acknowledged_db_contract" ([int]$ackCount -ge 1) "acknowledged=$ackCount patientId=$patientId"

Write-SmokeResults $results

$failed = @($results | Where-Object { -not $_.ok })
if ($failed.Count -gt 0) {
  Write-Error "Staff clinical-safety smoke failed: $($failed.Count) check(s) failed."
  exit 1
}

Write-Host "Staff clinical-safety smoke passed: $($results.Count) check(s)."
} finally {
  # A terminating error above must not discard the checks already recorded.
  # Write-SmokeResults is idempotent, so the normal path prints where it
  # always did and this is a no-op after it.
  Write-SmokeResults $results
}
