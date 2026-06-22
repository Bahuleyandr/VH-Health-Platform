<#
.SYNOPSIS
Runs a local patient portal API wiring smoke matrix against the backend.

.DESCRIPTION
Assumes the local backend and Postgres smoke database are already running. The
script seeds disposable patient/doctor identities, exercises representative
patient portal routes exactly as the Flutter app calls them, and exits non-zero
when any endpoint contract fails.
#>
[CmdletBinding()]
param(
  [string]$BackendBase = "http://127.0.0.1:5206",
  [string]$BackendDir = "",
  [string]$PatientUid = "44444444-4444-4444-8444-444444444444",
  [string]$DoctorUid = "55555555-5555-4555-8555-555555555555",
  [string]$PatientPhone = "8811000101",
  [string]$DoctorPhone = "8811000102",
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

function Normalize-SmokePhone {
  param([Parameter(Mandatory)][string]$Phone)

  $digits = ($Phone -replace '[^\d+]', '')
  if ($digits.StartsWith('+')) { return $digits }
  if ($digits.StartsWith('91') -and $digits.Length -eq 12) { return "+$digits" }
  if ($digits.Length -eq 10) { return "+91$digits" }
  return "+$digits"
}

$NormalizedPatientPhone = Normalize-SmokePhone $PatientPhone
$NormalizedDoctorPhone = Normalize-SmokePhone $DoctorPhone

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
    [Parameter(Mandatory)][int]$UserId,
    [Parameter(Mandatory)][string]$Phone,
    [string]$Role = "PATIENT"
  )

  $previousSecret = $env:SMOKE_JWT_SECRET
  $previousUid = $env:SMOKE_UID
  $previousUserId = $env:SMOKE_USER_ID
  $previousPhone = $env:SMOKE_PHONE
  $previousRole = $env:SMOKE_ROLE
  $env:SMOKE_JWT_SECRET = $JwtSecret
  $env:SMOKE_UID = $Uid
  $env:SMOKE_USER_ID = [string]$UserId
  $env:SMOKE_PHONE = $Phone
  $env:SMOKE_ROLE = $Role

  try {
    Push-Location $BackendDir
    try {
      $script = @'
const jwt = require('jsonwebtoken');
const uid = process.env.SMOKE_UID;
const id = Number(process.env.SMOKE_USER_ID);
const role = process.env.SMOKE_ROLE;
const phone = process.env.SMOKE_PHONE;
console.log(jwt.sign({
  uid,
  sub: uid,
  id,
  role,
  phone,
  email: `${uid}@patient-smoke.local`
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
    $env:SMOKE_USER_ID = $previousUserId
    $env:SMOKE_PHONE = $previousPhone
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
    [string]$AuthToken = $script:PatientToken
  )

  $uri = "$($BackendBase.TrimEnd('/'))$Path"
  $headers = @{
    "x-api-key" = $ApiKey
  }
  if ($AuthToken) {
    $headers.Authorization = "Bearer $AuthToken"
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
    if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey("UseBasicParsing")) {
      $params.UseBasicParsing = $true
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
    $httpResponse = $null
    if ($_.Exception.PSObject.Properties["Response"]) {
      $httpResponse = $_.Exception.Response
    }
    if ($null -ne $httpResponse -and $httpResponse.PSObject.Properties["StatusCode"]) {
      $status = [int]$httpResponse.StatusCode
      $content = ""
      try {
        $stream = $httpResponse.GetResponseStream()
        if ($null -ne $stream) {
          $reader = [System.IO.StreamReader]::new($stream)
          try {
            $content = $reader.ReadToEnd()
          } finally {
            $reader.Dispose()
          }
        }
      } catch {
        $content = ""
      }

      $message = ""
      if ($content) {
        try {
          $json = $content | ConvertFrom-Json
          if ($json.message) {
            $message = [string]$json.message
          } elseif ($json.error) {
            $message = [string]$json.error
          }
        } catch {
          $message = $content.Substring(0, [Math]::Min(160, $content.Length))
        }
      }

      Add-Result $Results $Name $status $false $message
      return [pscustomobject]@{
        StatusCode = $status
        Content = $content
      }
    }

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
$appointmentDate = (Get-Date).AddDays(5 + ((Get-Date).Second % 10)).ToString("yyyy-MM-dd")
$appointmentMinute = ((Get-Date).Minute + 7) % 60
$appointmentHour = 9 + ((Get-Date).Minute % 8)
$appointmentTime = "{0:00}:{1:00}" -f $appointmentHour, $appointmentMinute
$deviceId = "patient-smoke-device-$stamp"

Invoke-Psql @"
INSERT INTO users (uid, phone, name, email, role, is_active, status, updated_at)
VALUES
  ('$PatientUid'::uuid, '$NormalizedPatientPhone', 'Patient Smoke $stamp', 'patient-smoke-$stamp@example.test', 'PATIENT', true, 'active', NOW()),
  ('$DoctorUid'::uuid, '$NormalizedDoctorPhone', 'Doctor Smoke $stamp', 'doctor-smoke-$stamp@example.test', 'DOCTOR', true, 'active', NOW())
ON CONFLICT (uid) DO UPDATE SET
  phone = EXCLUDED.phone,
  name = EXCLUDED.name,
  email = EXCLUDED.email,
  role = EXCLUDED.role,
  is_active = true,
  status = 'active',
  updated_at = NOW();

INSERT INTO departments (name, description, is_active, updated_at)
VALUES ('Smoke Medicine', 'Local patient smoke department', true, NOW())
ON CONFLICT (tenant_id, name) DO UPDATE SET
  description = EXCLUDED.description,
  is_active = true,
  updated_at = NOW();

DELETE FROM doctors WHERE user_id = (SELECT id FROM users WHERE uid = '$DoctorUid'::uuid);
INSERT INTO doctors (user_id, name, department_id, department, specialty, intro, is_available, is_active, updated_at)
VALUES (
  (SELECT id FROM users WHERE uid = '$DoctorUid'::uuid),
  'Doctor Smoke $stamp',
  (SELECT id FROM departments WHERE name = 'Smoke Medicine'),
  'Smoke Medicine',
  'General Medicine',
  'Local patient smoke doctor',
  true,
  true,
  NOW()
);

INSERT INTO investigation_test_catalog (name, code, category, default_cost, turnaround_hours, home_collection_surcharge)
SELECT 'Patient Smoke CBC', 'PATIENT_SMOKE_CBC', 'blood', 1.00, 1, 0.00
WHERE NOT EXISTS (SELECT 1 FROM investigation_test_catalog WHERE code = 'PATIENT_SMOKE_CBC');
"@ | Out-Null

$patientId = [int](Invoke-Psql "SELECT id FROM users WHERE uid = '$PatientUid'::uuid;")
$doctorId = [int](Invoke-Psql "SELECT id FROM users WHERE uid = '$DoctorUid'::uuid;")
$testId = [int](Invoke-Psql "SELECT id FROM investigation_test_catalog WHERE code = 'PATIENT_SMOKE_CBC' ORDER BY id LIMIT 1;")

Invoke-Psql @"
INSERT INTO notifications (uid, phone, title, body, type, priority, data, is_read, created_at, updated_at)
VALUES ('$PatientUid'::uuid, '$NormalizedPatientPhone', 'Patient smoke notification $stamp', 'Smoke notification body', 'general', 'normal', '{}'::jsonb, false, NOW(), NOW());

INSERT INTO e_prescriptions (patient_id, doctor_id, diagnosis, clinical_notes, medications, status, created_by, created_at, updated_at)
VALUES (
  $patientId,
  $doctorId,
  'Smoke follow-up',
  'Patient smoke prescription',
  jsonb_build_array(jsonb_build_object('name', 'Dolo 650', 'dosage', '1 tablet', 'frequency', 'BD', 'duration', '3 days')),
  'created',
  $doctorId,
  NOW(),
  NOW()
);
"@ | Out-Null

$script:PatientToken = New-SmokeToken -Uid $PatientUid -UserId $patientId -Phone $PatientPhone
$results = [System.Collections.Generic.List[object]]::new()

Invoke-SmokeRequest $results "dashboard_summary" "GET" "/api/v1/dashboard?phone=$PatientPhone" | Out-Null
Invoke-SmokeRequest $results "departments_with_doctors" "GET" "/api/v1/departments/departments-with-doctors" | Out-Null
Invoke-SmokeRequest $results "appointments_patient_initial" "GET" "/api/v1/appointments/patient/$patientId" | Out-Null

$appointmentCreate = Invoke-SmokeRequest $results "appointments_book" "POST" "/api/v1/appointments/book" @{
  patient_id = $patientId
  doctor_id = $doctorId
  appointment_date = $appointmentDate
  appointment_time = $appointmentTime
  reason = "Patient smoke appointment $stamp"
}
$appointmentJson = Get-JsonContent $appointmentCreate
$appointmentData = Get-JsonProperty $appointmentJson "data"
$appointmentId = Get-JsonProperty $appointmentData "id"
if (-not $appointmentId) {
  $appointmentId = Get-JsonProperty (Get-JsonProperty $appointmentData "appointment") "id"
}

Invoke-SmokeRequest $results "appointments_patient_after_book" "GET" "/api/v1/appointments/patient/$patientId" | Out-Null
Invoke-SmokeRequest $results "patient_records_all" "GET" "/api/v1/appointments/patient/records/all" | Out-Null
if ($appointmentId) {
  Invoke-SmokeRequest $results "appointment_documents" "GET" "/api/v1/appointments/$appointmentId/documents" | Out-Null
} else {
  Add-Result $results "appointment_documents" "SKIP" $false "appointment id not found after booking"
}

Invoke-SmokeRequest $results "health_vitals_create" "POST" "/api/v1/health/patient/vitals" @{
  heartRate = 72
  spO2 = 98
  weight = 70.5
  mood = "good"
} | Out-Null
Invoke-SmokeRequest $results "health_vitals_history" "GET" "/api/v1/health/patient/$PatientUid/vitals" | Out-Null
Invoke-SmokeRequest $results "health_summary" "GET" "/api/v1/health/patient/$patientId/summary" | Out-Null
Invoke-SmokeRequest $results "health_allergies" "GET" "/api/v1/health/patient/$patientId/allergies" | Out-Null
Invoke-SmokeRequest $results "health_conditions" "GET" "/api/v1/health/patient/$patientId/conditions" | Out-Null

Invoke-SmokeRequest $results "notifications_my" "GET" "/api/v1/notifications/my" | Out-Null
Invoke-SmokeRequest $results "notifications_mark_all_read" "PATCH" "/api/v1/notifications/my/mark-all-read" | Out-Null

Invoke-SmokeRequest $results "devices_register" "POST" "/api/v1/devices/register" @{
  phone = $PatientPhone
  fcmToken = "patient-smoke-fcm-$stamp"
  deviceId = $deviceId
  deviceName = "patient-smoke-device"
  platform = "test"
} | Out-Null
Invoke-SmokeRequest $results "devices_my" "GET" "/api/v1/devices/my-devices" | Out-Null
Invoke-SmokeRequest $results "devices_heartbeat" "POST" "/api/v1/devices/heartbeat" @{
  phone = $PatientPhone
  deviceId = $deviceId
} | Out-Null
Invoke-SmokeRequest $results "devices_update_token" "POST" "/api/v1/devices/update-token" @{
  phone = $PatientPhone
  deviceId = $deviceId
  fcmToken = "patient-smoke-fcm-updated-$stamp"
} | Out-Null

Invoke-SmokeRequest $results "feedback_quick_rating" "POST" "/api/v1/feedback/quick-rating" @{
  phone = $PatientPhone
  rating = 5
  category = "quick"
} | Out-Null
Invoke-SmokeRequest $results "feedback_my_feedback" "GET" "/api/v1/feedback/my-feedback" | Out-Null
Invoke-SmokeRequest $results "feedback_my_stats" "GET" "/api/v1/feedback/my-stats" | Out-Null

$sosCreate = Invoke-SmokeRequest $results "sos_create_test" "POST" "/api/v1/sos/" @{
  phone = $PatientPhone
  latitude = 13.0827
  longitude = 80.2707
  emergencyType = "medical"
  severity = "low"
  message = "Patient smoke test alert $stamp"
  isTestAlert = $true
}
$sosJson = Get-JsonContent $sosCreate
$sosAlertId = Get-JsonProperty (Get-JsonProperty $sosJson "data") "alert_id"
Invoke-SmokeRequest $results "sos_my_alerts" "GET" "/api/v1/sos/my-alerts" | Out-Null
Invoke-SmokeRequest $results "sos_nearby_services" "GET" "/api/v1/sos/nearby-services?latitude=13.0827&longitude=80.2707" | Out-Null
Invoke-SmokeRequest $results "sos_nearby_services_lat_lng" "GET" "/api/v1/sos/nearby-services?lat=13.0827&lng=80.2707" | Out-Null
if ($sosAlertId) {
  Invoke-SmokeRequest $results "sos_cancel" "POST" "/api/v1/sos/cancel/$sosAlertId" | Out-Null
} else {
  Add-Result $results "sos_cancel" "SKIP" $false "alert id not found after create"
}

Invoke-SmokeRequest $results "pharmacy_orders_my" "GET" "/api/v1/pharmacy-orders/orders/my" | Out-Null
Invoke-SmokeRequest $results "investigations_catalog" "GET" "/api/v1/investigations/catalog" | Out-Null
Invoke-SmokeRequest $results "investigations_booking_create" "POST" "/api/v1/investigations/bookings/create" @{
  selected_tests = @($testId)
  collection_type = "walk_in"
  preferred_date = $appointmentDate
  preferred_time_slot = "09:00-12:00"
  notes = "Patient smoke booking $stamp"
} | Out-Null
Invoke-SmokeRequest $results "investigations_bookings_my" "GET" "/api/v1/investigations/bookings/my" | Out-Null
Invoke-SmokeRequest $results "prescriptions_patient_my" "GET" "/api/v1/prescriptions/patient/my" | Out-Null

Invoke-SmokeRequest $results "devices_unregister" "POST" "/api/v1/devices/unregister" @{
  phone = $PatientPhone
  deviceId = $deviceId
} | Out-Null

$results | Format-Table -AutoSize

$failed = @($results | Where-Object { -not $_.ok })
if ($failed.Count -gt 0) {
  Write-Error "Patient routing smoke failed: $($failed.Count) check(s) failed."
  exit 1
}

Write-Host "Patient routing smoke passed: $($results.Count) check(s)."
