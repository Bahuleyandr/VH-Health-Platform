<#
.SYNOPSIS
Runs a local admin dashboard CRUD smoke matrix through the admin proxy.

.DESCRIPTION
Assumes the local backend, admin portal, and Postgres smoke database are
already running. The script seeds disposable records, exercises the admin
portal proxy, and exits non-zero when any endpoint fails.
#>
[CmdletBinding()]
param(
  [string]$AdminProxyBase = "http://127.0.0.1:3201/api/proxy",
  [string]$BackendDir = (Join-Path $PSScriptRoot "..\apps\backend"),
  [string]$AdminUid = "f974d551-2d5b-413f-b287-718374374739",
  [string]$JwtSecret = "vhhealth-local-admin-smoke-secret-123456789",
  [string]$PgHost = "127.0.0.1",
  [int]$PgPort = 55432,
  [string]$PgUser = "postgres",
  [string]$PgDatabase = "vhhealth_test",
  [string]$PgPassword = "",
  [string]$PsqlPath = "psql"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Invoke-PsqlScalar {
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

function New-SmokeToken {
  $previousSecret = $env:SMOKE_JWT_SECRET
  $previousUid = $env:SMOKE_ADMIN_UID
  $env:SMOKE_JWT_SECRET = $JwtSecret
  $env:SMOKE_ADMIN_UID = $AdminUid

  try {
    Push-Location $BackendDir
    try {
      $script = @'
const jwt = require("jsonwebtoken");
console.log(jwt.sign({
  uid: process.env.SMOKE_ADMIN_UID,
  role: "SUPER_ADMIN",
  username: "smoke",
  email: "smoke@local"
}, process.env.SMOKE_JWT_SECRET, { expiresIn: "4h" }));
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
    $env:SMOKE_ADMIN_UID = $previousUid
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
    [object]$Body = $null
  )

  $uri = "$($AdminProxyBase.TrimEnd('/'))$Path"
  $headers = @{
    Cookie = "auth_token=$script:Token"
    Origin = "http://127.0.0.1:3201"
  }

  try {
    $params = @{
      Uri = $uri
      Method = $Method
      Headers = $headers
      SkipHttpErrorCheck = $true
    }

    if ($null -ne $Body) {
      $params.Body = ($Body | ConvertTo-Json -Depth 10)
      $params.ContentType = "application/json"
      $headers["Content-Type"] = "application/json"
    }

    $response = Invoke-WebRequest @params
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

    $ok = $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    Add-Result $Results $Name ([int]$response.StatusCode) $ok $message
    return $response
  } catch {
    Add-Result $Results $Name "ERR" $false $_.Exception.Message
    return $null
  }
}

Assert-Command "node"
Assert-Command $PsqlPath

$script:Token = New-SmokeToken
. (Join-Path $PSScriptRoot "lib/smoke-results.ps1")

$results = [System.Collections.Generic.List[object]]::new()

try {
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$suffix = $stamp.Substring($stamp.Length - 6)

$patientPhone = "8870$suffix"
$patientEmail = "crud-smoke-$stamp@example.test"
$patientUid = Invoke-PsqlScalar @"
WITH upsert AS (
  INSERT INTO users (phone, name, email, role, is_active, status, updated_at)
  VALUES ('$patientPhone', 'CRUD Smoke Patient $stamp', '$patientEmail', 'PATIENT', true, 'active', NOW())
  ON CONFLICT (phone) DO UPDATE SET
    name = EXCLUDED.name,
    email = EXCLUDED.email,
    role = EXCLUDED.role,
    is_active = true,
    status = 'active',
    updated_at = NOW()
  RETURNING uid
)
SELECT uid::text FROM upsert;
"@

Invoke-SmokeRequest $results "users_list" "GET" "/api/v1/users?limit=1" | Out-Null
Invoke-SmokeRequest $results "user_status_inactive" "PUT" "/api/v1/users/$patientUid/status" @{
  status = "inactive"
  reason = "Admin CRUD smoke"
} | Out-Null
Invoke-SmokeRequest $results "user_reactivate" "POST" "/api/v1/users/admin/reactivate/$patientUid" | Out-Null

$staffPhone = "8860$suffix"
$staffEmail = "staff-reactivate-$stamp@example.test"
$staffUid = Invoke-PsqlScalar @"
WITH u AS (
  INSERT INTO users (phone, name, email, role, is_active, status, updated_at)
  VALUES ('$staffPhone', 'Staff Reactivate $stamp', '$staffEmail', 'NURSE', false, 'inactive', NOW())
  ON CONFLICT (phone) DO UPDATE SET
    is_active = false,
    status = 'inactive',
    updated_at = NOW()
  RETURNING uid, id
)
INSERT INTO staff (user_id, name, designation, department, is_active, updated_at)
SELECT uid, 'Staff Reactivate $stamp', 'Nurse', 'General', false, NOW()
FROM u
RETURNING user_id::text;
"@
Invoke-SmokeRequest $results "staff_reactivate" "POST" "/api/v1/users/admin/reactivate/$staffUid" | Out-Null
$staffState = Invoke-PsqlScalar "SELECT u.status || '|' || u.is_active::text || '|' || s.is_active::text FROM users u JOIN staff s ON s.user_id = u.uid WHERE u.uid = '$staffUid'::uuid ORDER BY s.id DESC LIMIT 1;"
if ($staffState -ne "active|true|true") {
  Add-Result $results "staff_reactivate_db" "DB" $false "Expected active|true|true, got $staffState"
} else {
  Add-Result $results "staff_reactivate_db" "DB" $true $staffState
}

$departmentName = "Smoke Dept $stamp"
Invoke-SmokeRequest $results "department_create" "POST" "/api/v1/departments/create" @{
  name = $departmentName
  description = "Admin CRUD smoke department"
  contact_number = "9876543210"
  location = "Smoke Wing"
  is_active = $true
} | Out-Null

$departmentId = Invoke-PsqlScalar "SELECT id FROM departments WHERE name = '$departmentName' ORDER BY id DESC LIMIT 1;"
if ($departmentId) {
  Invoke-SmokeRequest $results "department_update" "PUT" "/api/v1/departments/$departmentId" @{
    description = "Admin CRUD smoke department updated"
    is_active = $true
  } | Out-Null
  Invoke-SmokeRequest $results "department_delete" "DELETE" "/api/v1/departments/$departmentId" | Out-Null
} else {
  Add-Result $results "department_update" "SKIP" $false "department id not found after create"
  Add-Result $results "department_delete" "SKIP" $false "department id not found after create"
}

Invoke-SmokeRequest $results "doctors_manage" "GET" "/api/v1/doctors/admin/manage?limit=1" | Out-Null

$doctorName = "Smoke Doctor $stamp"
$doctorPhone = "9930$suffix"
$doctorEmail = "doctor-smoke-$stamp@example.test"
Invoke-SmokeRequest $results "doctor_create" "POST" "/api/v1/doctors/admin/create" @{
  name = $doctorName
  phone = $doctorPhone
  email = $doctorEmail
  specialization = "Cardiology"
  department = "Cardiology"
  bio = "Admin CRUD smoke doctor"
  consultation_fee = 100
} | Out-Null

$doctorId = Invoke-PsqlScalar "SELECT id FROM doctors WHERE name = '$doctorName' ORDER BY id DESC LIMIT 1;"
if ($doctorId) {
  Invoke-SmokeRequest $results "doctor_update_profile" "PUT" "/api/v1/doctors/admin/$doctorId/profile" @{
    specialization = "Cardiology"
    department = "Cardiology"
    bio = "Admin CRUD smoke doctor updated"
  } | Out-Null
  Invoke-SmokeRequest $results "doctor_availability" "PUT" "/api/v1/doctors/admin/$doctorId/availability" @{
    is_available = $false
    reason = "Admin CRUD smoke availability"
  } | Out-Null
  Invoke-SmokeRequest $results "doctor_delete_account" "DELETE" "/api/v1/doctors/admin/$doctorId/account" @{
    reason = "Admin CRUD smoke cleanup"
  } | Out-Null
} else {
  Add-Result $results "doctor_update_profile" "SKIP" $false "doctor id not found after create"
  Add-Result $results "doctor_availability" "SKIP" $false "doctor id not found after create"
  Add-Result $results "doctor_delete_account" "SKIP" $false "doctor id not found after create"
}

Invoke-SmokeRequest $results "system_settings_get" "GET" "/api/v1/system/settings" | Out-Null
Invoke-SmokeRequest $results "system_settings_put" "PUT" "/api/v1/system/settings" @{
  maintenanceMode = $false
  sessionTimeoutMinutes = 61
} | Out-Null

# Persistence round-trip: settings live in the system_settings table
# (migration 724). Before that table existed the backend swallowed the
# missing relation and answered 200 from a per-process in-memory object, so
# these checks read green while every request errored in the Postgres logs.
# A re-read must return the non-default value the PUT just wrote.
$settingsAfterPut = Invoke-SmokeRequest $results "system_settings_get_after_put" "GET" "/api/v1/system/settings"
$persistedValue = $null
if ($settingsAfterPut -and $settingsAfterPut.Content) {
  try {
    $persistedValue = ($settingsAfterPut.Content | ConvertFrom-Json).data.sessionTimeoutMinutes
  } catch {
    $persistedValue = $null
  }
}
Add-Result $results "system_settings_persisted" $(if ($persistedValue -eq 61) { "OK" } else { "FAIL" }) ($persistedValue -eq 61) "sessionTimeoutMinutes=$persistedValue (expected 61)"
Invoke-SmokeRequest $results "system_settings_put_restore" "PUT" "/api/v1/system/settings" @{
  sessionTimeoutMinutes = 60
} | Out-Null
Invoke-SmokeRequest $results "clinical_ai_status" "GET" "/api/v1/admin/clinical-ai/status?days=1" | Out-Null
Invoke-SmokeRequest $results "clinical_ai_modules" "GET" "/api/v1/admin/clinical-ai/modules" | Out-Null
Invoke-SmokeRequest $results "clinical_ai_reviews" "GET" "/api/v1/admin/clinical-ai/reviews?limit=1" | Out-Null
Invoke-SmokeRequest $results "clinical_ai_audit" "GET" "/api/v1/admin/clinical-ai/audit?limit=1" | Out-Null

Write-SmokeResults $results

$failed = @($results | Where-Object { -not $_.ok })
if ($failed.Count -gt 0) {
  Write-Error "Admin CRUD smoke failed: $($failed.Count) check(s) failed."
  exit 1
}

Write-Host "Admin CRUD smoke passed: $($results.Count) check(s)."
} finally {
  # A terminating error above must not discard the checks already recorded.
  # Write-SmokeResults is idempotent, so the normal path prints where it
  # always did and this is a no-op after it.
  Write-SmokeResults $results
}
