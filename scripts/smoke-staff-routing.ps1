<#
.SYNOPSIS
Runs a local staff portal API wiring smoke matrix against the backend.

.DESCRIPTION
Assumes the local backend and Postgres smoke database are already running. The
script seeds disposable staff/patient identities, exercises representative staff
portal routes, and exits non-zero when any endpoint contract fails.
#>
[CmdletBinding()]
param(
  [string]$BackendBase = "http://127.0.0.1:5206",
  [string]$BackendDir = (Join-Path $PSScriptRoot "..\apps\backend"),
  [string]$StaffUid = "11111111-1111-4111-8111-111111111111",
  [string]$RecipientUid = "22222222-2222-4222-8222-222222222222",
  [string]$PatientUid = "33333333-3333-4333-8333-333333333333",
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

function New-SmokeToken {
  param(
    [Parameter(Mandatory)][string]$Uid,
    [string]$Role = "NURSING_STAFF"
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
const jwt = require("jsonwebtoken");
const uid = process.env.SMOKE_UID;
const role = process.env.SMOKE_ROLE;
console.log(jwt.sign({
  uid,
  sub: uid,
  role,
  email: `${uid}@staff-smoke.local`
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
    [string]$AuthToken = $script:StaffToken
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

Assert-Command "node"
Assert-Command $PsqlPath

$stamp = Get-Date -Format "yyyyMMddHHmmss"

Invoke-Psql @"
INSERT INTO users (uid, phone, name, email, role, is_active, status, updated_at)
VALUES
  ('$StaffUid'::uuid, '8811000001', 'Staff Smoke Sender $stamp', 'staff-smoke-sender-$stamp@example.test', 'NURSE', true, 'active', NOW()),
  ('$RecipientUid'::uuid, '8811000002', 'Staff Smoke Recipient $stamp', 'staff-smoke-recipient-$stamp@example.test', 'NURSE', true, 'active', NOW()),
  ('$PatientUid'::uuid, '8811000003', 'Staff Smoke Patient $stamp', 'staff-smoke-patient-$stamp@example.test', 'PATIENT', true, 'active', NOW())
ON CONFLICT (uid) DO UPDATE SET
  name = EXCLUDED.name,
  email = EXCLUDED.email,
  role = EXCLUDED.role,
  is_active = true,
  status = 'active',
  updated_at = NOW();
"@ | Out-Null

$script:StaffToken = New-SmokeToken -Uid $StaffUid
$recipientToken = New-SmokeToken -Uid $RecipientUid
$results = [System.Collections.Generic.List[object]]::new()

Invoke-SmokeRequest $results "config_campus_locations" "GET" "/api/v1/config/campus-locations" | Out-Null
Invoke-SmokeRequest $results "staff_stats_summary" "GET" "/api/v1/staff/stats/summary" | Out-Null
Invoke-SmokeRequest $results "dietary_worklist" "GET" "/api/v1/dietary/worklist?limit=1" | Out-Null
Invoke-SmokeRequest $results "investigations_queue" "GET" "/api/v1/investigations/bookings/queue?limit=1" | Out-Null
Invoke-SmokeRequest $results "investigations_sla" "GET" "/api/v1/investigations/bookings/sla" | Out-Null

$dietCreate = Invoke-SmokeRequest $results "dietary_create" "POST" "/api/v1/dietary/orders" @{
  patient_uid = $PatientUid
  diet_type = "regular"
  meal_preferences = "Lunch"
  restrictions = @("no peanuts")
  special_instructions = "Staff smoke $stamp"
}
$dietJson = Get-JsonContent $dietCreate
$dietId = Get-JsonProperty (Get-JsonProperty $dietJson "data") "id"
if ($dietId) {
  Invoke-SmokeRequest $results "dietary_discontinue" "PUT" "/api/v1/dietary/$dietId" @{
    status = "discontinued"
  } | Out-Null
} else {
  Add-Result $results "dietary_discontinue" "SKIP" $false "diet order id not found after create"
}

$messageCreate = Invoke-SmokeRequest $results "messaging_send" "POST" "/api/v1/messaging/send" @{
  recipient_uid = $RecipientUid
  body = "Staff smoke message $stamp"
  priority = "normal"
}
$messageJson = Get-JsonContent $messageCreate
$messageId = Get-JsonProperty (Get-JsonProperty $messageJson "data") "id"

if ($messageId) {
  $outboxCount = Invoke-Psql "SELECT COUNT(*) FROM notification_outbox no JOIN users u ON u.id::text = no.recipient_id::text WHERE u.uid = '$RecipientUid'::uuid AND no.payload->>'message_id' = '$messageId';"
  Add-Result $results "messaging_notification_outbox" "DB" ([int]$outboxCount -ge 1) "queued=$outboxCount"
} else {
  Add-Result $results "messaging_notification_outbox" "SKIP" $false "message id not found after send"
}

Invoke-SmokeRequest $results "messaging_thread" "GET" "/api/v1/messaging/thread/$RecipientUid" | Out-Null
Invoke-SmokeRequest $results "messaging_recipient_inbox" "GET" "/api/v1/messaging/inbox" -AuthToken $recipientToken | Out-Null
Invoke-SmokeRequest $results "messaging_recipient_unread_count" "GET" "/api/v1/messaging/unread-count" -AuthToken $recipientToken | Out-Null

if ($messageId) {
  Invoke-SmokeRequest $results "messaging_mark_read" "PATCH" "/api/v1/messaging/$messageId/read" -AuthToken $recipientToken | Out-Null
} else {
  Add-Result $results "messaging_mark_read" "SKIP" $false "message id not found after send"
}

$results | Format-Table -AutoSize

$failed = @($results | Where-Object { -not $_.ok })
if ($failed.Count -gt 0) {
  Write-Error "Staff routing smoke failed: $($failed.Count) check(s) failed."
  exit 1
}

Write-Host "Staff routing smoke passed: $($results.Count) check(s)."
