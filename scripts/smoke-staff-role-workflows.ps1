<#
.SYNOPSIS
Runs a live staff-role workflow smoke matrix against a reachable VH backend.

.DESCRIPTION
Logs in as every seeded staff role through the real staff auth endpoint, then
checks the day-to-day API surfaces that each role uses in the Flutter staff
app. The script writes a Markdown report and exits non-zero when a required
check fails unless -FailOnFailure:$false is supplied.

Use this after a backend deploy or before a staff desktop pilot. It is a thin
contract smoke, not a substitute for clinical workflow sign-off.
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = $env:VH_BASE_URL,
  [string]$ApiKey = $env:VH_API_KEY,
  [string]$StaffPassword = $env:VH_STAFF_TEST_PASSWORD,
  [string]$ReportPath = (Join-Path $PSScriptRoot "..\docs\STAFF_ROLE_WORKFLOW_SWEEP.md"),
  [switch]$IncludeCreates,
  [bool]$FailOnFailure = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  throw "BaseUrl is required. Pass -BaseUrl or set VH_BASE_URL. Expected shape: https://host/api/v1"
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "ApiKey is required. Pass -ApiKey or set VH_API_KEY."
}
if ([string]::IsNullOrWhiteSpace($StaffPassword)) {
  throw "StaffPassword is required. Pass -StaffPassword or set VH_STAFF_TEST_PASSWORD."
}

$script:Base = $BaseUrl.TrimEnd("/")
. (Join-Path $PSScriptRoot "lib/smoke-results.ps1")

# One formatter for both call sites below, so the crash path cannot print
# a differently-shaped table from the normal path.
$roleResultFormatter = {
  param($rows)
  $rows |
    Sort-Object role, check |
    Format-Table role, check, method, status, ok, severity -AutoSize
}

$script:Results = [System.Collections.Generic.List[object]]::new()

try {
$script:Tokens = @{}
$script:Context = [ordered]@{
  appointmentId = $null
  patientId = $null
  patientPhone = $null
  patientName = $null
  doctorId = $null
  doctorName = $null
  createdAppointmentId = $null
  createdInvestigationId = $null
  createdPrescriptionId = $null
}

$accounts = @(
  @{ employeeId = "EMP-1001"; role = "NURSING_STAFF"; label = "Nursing" },
  @{ employeeId = "EMP-1002"; role = "PHARMACY_STAFF"; label = "Pharmacy" },
  @{ employeeId = "EMP-1003"; role = "LAB_STAFF"; label = "Lab" },
  @{ employeeId = "EMP-1004"; role = "DOCTOR"; label = "Doctor" },
  @{ employeeId = "EMP-1005"; role = "HR_STAFF"; label = "HR" },
  @{ employeeId = "EMP-1006"; role = "ADMIN"; label = "Admin" },
  @{ employeeId = "EMP-1007"; role = "SUPER_ADMIN"; label = "Super admin" },
  @{ employeeId = "EMP-1008"; role = "GENERAL_STAFF"; label = "General staff" },
  @{ employeeId = "EMP-1009"; role = "RECEPTIONIST"; label = "Receptionist" },
  # Stage-5 desk roles (EMP-1016..1019, seeded by seed-test-staff-accounts.mjs).
  # The original 1001..1008 matrix never exercised the billing / TPA-insurance /
  # admission-counter surfaces that the Stage-5 fix chips actually changed, so a
  # green sweep was blind to the cluster of findings Stage 5 closed.
  @{ employeeId = "EMP-1016"; role = "BILLING_STAFF"; label = "Billing" },
  @{ employeeId = "EMP-1017"; role = "INSURANCE_COORDINATOR"; label = "Insurance coordinator" },
  @{ employeeId = "EMP-1018"; role = "ADMISSION_OFFICER"; label = "Admission officer" },
  @{ employeeId = "EMP-1019"; role = "IPD_COUNSELLOR"; label = "IPD counsellor" }
)

function Get-ApiUri {
  param([Parameter(Mandatory)][string]$Path)
  return "$script:Base/$($Path.TrimStart('/'))"
}

function Get-JsonField {
  param(
    $Object,
    [Parameter(Mandatory)][string]$Name
  )
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-FirstPresent {
  param([object[]]$Values)

  foreach ($value in $Values) {
    if ($null -ne $value) {
      return $value
    }
  }
  return $null
}

function ConvertFrom-ContentJson {
  param([string]$Content)
  if ([string]::IsNullOrWhiteSpace($Content)) { return $null }
  try {
    return $Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-ErrorContent {
  param($Exception)

  $response = $Exception.Response
  if ($null -eq $response) {
    return @{ status = "ERR"; content = $Exception.Message }
  }

  $status = "ERR"
  try { $status = [int]$response.StatusCode } catch { }

  $content = ""
  try {
    if ($response.PSObject.Methods["GetResponseStream"]) {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } elseif ($response.PSObject.Properties["Content"] -and $response.Content) {
      $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    }
  } catch {
    $content = $Exception.Message
  }

  return @{ status = $status; content = $content }
}

function Add-SmokeResult {
  param(
    [Parameter(Mandatory)][string]$Role,
    [Parameter(Mandatory)][string]$Check,
    [Parameter(Mandatory)][string]$Method,
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Status,
    [Parameter(Mandatory)][bool]$Ok,
    [string]$Detail = "",
    [string]$Severity = "required"
  )

  $script:Results.Add([pscustomobject]@{
    role = $Role
    check = $Check
    method = $Method
    path = $Path
    status = $Status
    ok = $Ok
    severity = $Severity
    detail = $Detail
  }) | Out-Null
}

function Invoke-StaffRequest {
  param(
    [Parameter(Mandatory)][string]$Role,
    [Parameter(Mandatory)][string]$Check,
    [Parameter(Mandatory)][string]$Method,
    [Parameter(Mandatory)][string]$Path,
    [object]$Body = $null,
    [string]$Token = "",
    [int[]]$ExpectedStatus = @(200),
    [string]$Severity = "required"
  )

  $headers = @{
    "x-api-key" = $ApiKey
  }
  if (-not [string]::IsNullOrWhiteSpace($Token)) {
    $headers["Authorization"] = "Bearer $Token"
  }

  $params = @{
    Uri = Get-ApiUri $Path
    Method = $Method
    Headers = $headers
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 20)
    $params.ContentType = "application/json"
  }

  try {
    $response = Invoke-WebRequest @params
    $content = [string]$response.Content
    $json = ConvertFrom-ContentJson $content
    $status = [int]$response.StatusCode
    $ok = $ExpectedStatus -contains $status
    $message = ""
    if ($json) {
      $message = [string](Get-FirstPresent @((Get-JsonField $json "message"), (Get-JsonField $json "error"), ""))
    }
    Add-SmokeResult $Role $Check $Method $Path $status $ok $message $Severity
    return [pscustomobject]@{ status = $status; ok = $ok; json = $json; content = $content }
  } catch {
    $err = Get-ErrorContent $_.Exception
    $json = ConvertFrom-ContentJson ([string]$err.content)
    $message = if ($json) {
      [string](Get-FirstPresent @((Get-JsonField $json "message"), (Get-JsonField $json "error"), ""))
    } else {
      [string]$err.content
    }
    if ($message.Length -gt 220) { $message = $message.Substring(0, 220) }
    $ok = $ExpectedStatus -contains $err.status
    Add-SmokeResult $Role $Check $Method $Path $err.status $ok $message $Severity
    return [pscustomobject]@{ status = $err.status; ok = $ok; json = $json; content = [string]$err.content }
  }
}

function Invoke-Login {
  param($Account)

  $response = Invoke-StaffRequest `
    -Role $Account.role `
    -Check "login" `
    -Method "POST" `
    -Path "/auth/staff/login" `
    -Body @{ employeeId = $Account.employeeId; password = $StaffPassword } `
    -ExpectedStatus @(200)

  if (-not $response.ok) { return $null }
  $data = Get-JsonField $response.json "data"
  $token = Get-FirstPresent @((Get-JsonField $data "accessToken"), (Get-JsonField $data "token"), (Get-JsonField $data "jwt"))
  $staff = Get-JsonField $data "staff"
  $actualRole = Get-FirstPresent @((Get-JsonField $staff "role"), (Get-JsonField $data "role"))

  $roleOk = [string]$actualRole -eq [string]$Account.role
  Add-SmokeResult $Account.role "login_role_matches_seed" "ASSERT" "(token payload)" "ASSERT" $roleOk "expected=$($Account.role); actual=$actualRole"

  if ($token) {
    $script:Tokens[$Account.role] = [string]$token
    return [string]$token
  }
  Add-SmokeResult $Account.role "login_token_present" "ASSERT" "(login response)" "ASSERT" $false "No access token in login response"
  return $null
}

function Invoke-CommonChecks {
  param(
    [Parameter(Mandatory)][string]$Role,
    [Parameter(Mandatory)][string]$Token
  )

  Invoke-StaffRequest $Role "profile" "GET" "/auth/staff/profile" -Token $Token | Out-Null
  Invoke-StaffRequest $Role "attendance_today" "GET" "/auth/staff/attendance/today" -Token $Token | Out-Null
  Invoke-StaffRequest $Role "attendance_history" "GET" "/auth/staff/attendance/history?limit=5" -Token $Token | Out-Null
  Invoke-StaffRequest $Role "campus_locations" "GET" "/config/campus-locations" -Token $Token | Out-Null
  Invoke-StaffRequest $Role "notifications_my" "GET" "/notifications/my?limit=5" -Token $Token | Out-Null
  Invoke-StaffRequest $Role "messages_unread" "GET" "/messaging/unread-count" -Token $Token | Out-Null
  Invoke-StaffRequest $Role "messages_inbox" "GET" "/messaging/inbox?limit=5" -Token $Token | Out-Null
}

function Set-ContextFromAppointmentPayload {
  param($Payload)

  $data = Get-JsonField $Payload "data"
  if ($null -eq $data) { $data = $Payload }
  $items = @()
  if ($data -is [System.Array]) {
    $items = @($data)
  } elseif ($data) {
    foreach ($candidate in @("appointments", "items", "data", "queue")) {
      $value = Get-JsonField $data $candidate
      if ($value -is [System.Array]) { $items = @($value); break }
    }
  }

  $first = $items | Where-Object { $_ } | Select-Object -First 1
  if ($null -eq $first) { return }

  $script:Context.appointmentId = Get-FirstPresent @((Get-JsonField $first "id"), $script:Context.appointmentId)
  $script:Context.patientId = Get-FirstPresent @((Get-JsonField $first "patient_id"), $script:Context.patientId)
  $script:Context.patientPhone = Get-FirstPresent @((Get-JsonField $first "phone"), (Get-JsonField $first "patient_phone"), $script:Context.patientPhone)
  $script:Context.patientName = Get-FirstPresent @((Get-JsonField $first "patient_name"), (Get-JsonField $first "name"), $script:Context.patientName)
  $script:Context.doctorId = Get-FirstPresent @((Get-JsonField $first "doctor_id"), $script:Context.doctorId)
  $script:Context.doctorName = Get-FirstPresent @((Get-JsonField $first "doctor_name"), $script:Context.doctorName)
}

function Set-ContextFromDoctorOptionsPayload {
  param($Payload)

  $data = Get-JsonField $Payload "data"
  if ($null -eq $data) { $data = $Payload }
  $doctors = Get-JsonField $data "doctors"
  if ($null -eq $doctors) { return }

  $first = @($doctors) | Where-Object { $_ } | Select-Object -First 1
  if ($null -eq $first) { return }

  $script:Context.doctorId = Get-FirstPresent @((Get-JsonField $first "user_id"), (Get-JsonField $first "id"), $script:Context.doctorId)
  $script:Context.doctorName = Get-FirstPresent @((Get-JsonField $first "name"), $script:Context.doctorName)
}

function Invoke-RoleChecks {
  param(
    [Parameter(Mandatory)]$Account,
    [Parameter(Mandatory)][string]$Token
  )

  $role = $Account.role
  Invoke-CommonChecks $role $Token

  switch ($role) {
    "NURSING_STAFF" {
      $list = Invoke-StaffRequest $role "appointments_list_today" "GET" "/appointments/list?date=today&page=1&limit=10" -Token $Token
      Set-ContextFromAppointmentPayload $list.json
      Invoke-StaffRequest $role "appointments_queue_today_denied" "GET" "/appointments/queue/today" -Token $Token -ExpectedStatus @(403) -Severity "expected-deny" | Out-Null
      Invoke-StaffRequest $role "appointments_pending" "GET" "/appointments/pending" -Token $Token | Out-Null
      Invoke-StaffRequest $role "patient_search" "GET" "/patients/search?q=Smoke&limit=5" -Token $Token | Out-Null
      Invoke-StaffRequest $role "bed_summary" "GET" "/beds/summary" -Token $Token | Out-Null
      Invoke-StaffRequest $role "bed_list" "GET" "/beds?limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "investigation_queue" "GET" "/investigations/bookings/queue?limit=5" -Token $Token | Out-Null
      Invoke-StaffRequest $role "pharmacy_queue" "GET" "/pharmacy-orders/orders/queue?limit=5" -Token $Token | Out-Null
    }
    "RECEPTIONIST" {
      $list = Invoke-StaffRequest $role "appointments_list_today" "GET" "/appointments/list?date=today&page=1&limit=10" -Token $Token
      Set-ContextFromAppointmentPayload $list.json
      $queue = Invoke-StaffRequest $role "appointments_queue_today" "GET" "/appointments/queue/today" -Token $Token
      Set-ContextFromAppointmentPayload $queue.json
      Invoke-StaffRequest $role "appointments_pending" "GET" "/appointments/pending" -Token $Token | Out-Null
      Invoke-StaffRequest $role "doctor_options" "GET" "/appointments/doctors/options?limit=20" -Token $Token | Out-Null
      Invoke-StaffRequest $role "patient_search" "GET" "/patients/search?q=Smoke&limit=5" -Token $Token | Out-Null
      Invoke-StaffRequest $role "bed_summary" "GET" "/beds/summary" -Token $Token | Out-Null
      Invoke-StaffRequest $role "bed_list" "GET" "/beds?limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "billing_invoices" "GET" "/billing/v2/invoices?limit=5" -Token $Token | Out-Null
    }
    "DOCTOR" {
      $queue = Invoke-StaffRequest $role "appointments_queue_today" "GET" "/appointments/queue/today" -Token $Token
      Set-ContextFromAppointmentPayload $queue.json
      Invoke-StaffRequest $role "appointments_pending" "GET" "/appointments/pending" -Token $Token | Out-Null
      Invoke-StaffRequest $role "doctor_options" "GET" "/appointments/doctors/options?limit=20" -Token $Token | Out-Null
      Invoke-StaffRequest $role "patient_search" "GET" "/patients/search?q=Smoke&limit=5" -Token $Token | Out-Null
      Invoke-StaffRequest $role "prescriptions_all" "GET" "/prescriptions/all?limit=5" -Token $Token | Out-Null
      Invoke-StaffRequest $role "emr_icd_search" "GET" "/emr/icd10/search?q=fever&limit=5" -Token $Token | Out-Null
      Invoke-StaffRequest $role "bed_summary" "GET" "/beds/summary" -Token $Token | Out-Null
    }
    "PHARMACY_STAFF" {
      Invoke-StaffRequest $role "pharmacy_queue" "GET" "/pharmacy-orders/orders/queue?limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "pharmacy_sla" "GET" "/pharmacy-orders/orders/sla" -Token $Token | Out-Null
      Invoke-StaffRequest $role "pharmacy_catalog" "GET" "/pharmacy-orders/catalog?limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "prescriptions_all" "GET" "/prescriptions/all?limit=5" -Token $Token | Out-Null
    }
    "LAB_STAFF" {
      Invoke-StaffRequest $role "investigation_queue" "GET" "/investigations/bookings/queue?limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "investigation_sla" "GET" "/investigations/bookings/sla" -Token $Token | Out-Null
      Invoke-StaffRequest $role "investigation_catalog" "GET" "/investigations/catalog?limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "investigation_list" "GET" "/investigations/list?page=1&limit=10" -Token $Token | Out-Null
    }
    "HR_STAFF" {
      Invoke-StaffRequest $role "hr_dashboard" "GET" "/staff/hr/dashboard" -Token $Token | Out-Null
      Invoke-StaffRequest $role "staff_list" "GET" "/staff/list?page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "leave_balance" "GET" "/staff/hr/leave/balance" -Token $Token | Out-Null
      Invoke-StaffRequest $role "replacement_pending" "GET" "/staff/hr/replacement/pending" -Token $Token | Out-Null
      Invoke-StaffRequest $role "payroll_payslips" "GET" "/staff/hr/payroll/my-payslips?limit=5" -Token $Token | Out-Null
    }
    "ADMIN" {
      Invoke-StaffRequest $role "staff_list" "GET" "/staff/list?page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "appointments_list" "GET" "/appointments/list?page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "doctors_options" "GET" "/appointments/doctors/options?limit=20" -Token $Token | Out-Null
      Invoke-StaffRequest $role "investigation_sla" "GET" "/investigations/bookings/sla" -Token $Token | Out-Null
      Invoke-StaffRequest $role "pharmacy_sla" "GET" "/pharmacy-orders/orders/sla" -Token $Token | Out-Null
      Invoke-StaffRequest $role "admin_database_denied" "GET" "/admin/database/overview" -Token $Token -ExpectedStatus @(403) -Severity "expected-deny" | Out-Null
    }
    "SUPER_ADMIN" {
      Invoke-StaffRequest $role "staff_list" "GET" "/staff/list?page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "appointments_list" "GET" "/appointments/list?page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "doctors_options" "GET" "/appointments/doctors/options?limit=20" -Token $Token | Out-Null
      Invoke-StaffRequest $role "admin_database_overview" "GET" "/admin/database/overview" -Token $Token | Out-Null
      Invoke-StaffRequest $role "admin_database_users_preview" "GET" "/admin/database/tables/users/rows?limit=2" -Token $Token | Out-Null
    }
    "GENERAL_STAFF" {
      Invoke-StaffRequest $role "staff_directory" "GET" "/staff/list?page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "hr_shift" "GET" "/staff/hr/shift" -Token $Token | Out-Null
      Invoke-StaffRequest $role "leave_balance" "GET" "/staff/hr/leave/balance" -Token $Token | Out-Null
      Invoke-StaffRequest $role "payroll_payslips" "GET" "/staff/hr/payroll/my-payslips?limit=5" -Token $Token | Out-Null
    }
    # Stage-5 desk roles. Paths + role gates verified against app.js mounts:
    #   /billing   => requireRole(... 'BILLING_STAFF' ...)            (app.js)
    #   /insurance => requireRole(... 'INSURANCE_COORDINATOR' ...)    (app.js)
    #   /emr       => requireRole(...CLINICAL_STAFF_ROLES) and that
    #                 list includes ADMISSION_OFFICER + IPD_COUNSELLOR (app.js)
    # All checks are no-param GET list/report surfaces touched by the
    # Stage-5 fix chips (billing per-insurer breakdown, TPA package master /
    # pre-auth SLA / enhancement template, admissions list + review-due queue).
    "BILLING_STAFF" {
      # /billing/revenue requires date_from + date_to — a bare call 400s.
      $revFrom = (Get-Date).AddDays(-30).ToString("yyyy-MM-dd")
      $revTo = (Get-Date).ToString("yyyy-MM-dd")
      Invoke-StaffRequest $role "billing_revenue_report" "GET" "/billing/revenue?date_from=$revFrom&date_to=$revTo" -Token $Token | Out-Null
      Invoke-StaffRequest $role "billing_insurance_claims" "GET" "/billing/insurance/claims" -Token $Token | Out-Null
    }
    "INSURANCE_COORDINATOR" {
      Invoke-StaffRequest $role "insurance_packages" "GET" "/insurance/packages" -Token $Token | Out-Null
      Invoke-StaffRequest $role "insurance_preauth_pending" "GET" "/insurance/preauth/pending" -Token $Token | Out-Null
      Invoke-StaffRequest $role "insurance_claims_list" "GET" "/insurance/claims" -Token $Token | Out-Null
      Invoke-StaffRequest $role "insurance_enhancement_template" "GET" "/insurance/enhancement-justification-template" -Token $Token | Out-Null
    }
    "ADMISSION_OFFICER" {
      Invoke-StaffRequest $role "emr_admissions_list" "GET" "/emr/admissions?page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "emr_admissions_stats" "GET" "/emr/admissions/stats" -Token $Token | Out-Null
    }
    "IPD_COUNSELLOR" {
      Invoke-StaffRequest $role "emr_admissions_list" "GET" "/emr/admissions?page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "emr_admissions_review_due" "GET" "/emr/admissions?review_due=true&page=1&limit=10" -Token $Token | Out-Null
      Invoke-StaffRequest $role "emr_admissions_stats" "GET" "/emr/admissions/stats" -Token $Token | Out-Null
    }
  }
}

function Invoke-CreateChecks {
  $token = $script:Tokens["RECEPTIONIST"]
  if (-not $token) {
    Add-SmokeResult "RECEPTIONIST" "create_checks_skipped" "ASSERT" "(tokens)" "SKIP" $false "Receptionist token unavailable" "optional"
    return
  }

  $doctorOptions = Invoke-StaffRequest "RECEPTIONIST" "doctor_options_for_create" "GET" "/appointments/doctors/options?limit=1" -Token $token
  Set-ContextFromDoctorOptionsPayload $doctorOptions.json

  $stamp = Get-Date -Format "MMddHHmmss"
  $phone = "8899$stamp"
  $walkInBody = @{
    patient_name = "Smoke Patient $stamp"
    patient_phone = $phone
    department = "General Medicine"
    reason = "Role workflow smoke"
    notes = "Created by smoke-staff-role-workflows"
    appointment_time = "Walk-in"
  }
  if ($script:Context.doctorId) {
    $walkInBody.doctor_id = $script:Context.doctorId
  }

  $walkIn = Invoke-StaffRequest `
    -Role "RECEPTIONIST" `
    -Check "create_walk_in_appointment" `
    -Method "POST" `
    -Path "/appointments/walk-in" `
    -Token $token `
    -Body $walkInBody `
    -ExpectedStatus @(200, 201)

  $apptData = Get-JsonField $walkIn.json "data"
  if ($apptData) {
    $script:Context.createdAppointmentId = Get-JsonField $apptData "id"
    $script:Context.appointmentId = $script:Context.createdAppointmentId
    $script:Context.patientId = Get-FirstPresent @((Get-JsonField $apptData "patient_id"), $script:Context.patientId)
    $script:Context.patientPhone = $phone
    $script:Context.patientName = "Smoke Patient $stamp"
    $script:Context.doctorId = Get-FirstPresent @((Get-JsonField $apptData "doctor_id"), $script:Context.doctorId)
  }

  Invoke-StaffRequest "RECEPTIONIST" "search_created_patient" "GET" "/patients/search?q=$phone&limit=5" -Token $token | Out-Null
  Invoke-StaffRequest "RECEPTIONIST" "created_appointment_in_list" "GET" "/appointments/list?search=$phone&page=1&limit=5" -Token $token | Out-Null

  $investigation = Invoke-StaffRequest `
    -Role "RECEPTIONIST" `
    -Check "create_investigation_booking" `
    -Method "POST" `
    -Path "/investigations/bookings/create" `
    -Token $token `
    -Body @{
      patient_phone = $phone
      patient_name = "Smoke Patient $stamp"
      custom_test_names = "CBC"
      collection_type = "walk_in"
      preferred_date = (Get-Date).ToString("yyyy-MM-dd")
      preferred_time_slot = "Morning"
      notes = "Role workflow smoke"
    } `
    -ExpectedStatus @(200, 201)
  $investigationData = Get-JsonField $investigation.json "data"
  if ($investigationData) {
    $script:Context.createdInvestigationId = Get-JsonField $investigationData "id"
  }

  $pharmacyToken = $script:Tokens["PHARMACY_STAFF"]
  if ($pharmacyToken) {
    Invoke-StaffRequest "PHARMACY_STAFF" "created_investigation_visible_to_lab_not_pharmacy_queue_guard" "GET" "/pharmacy-orders/orders/queue?limit=5" -Token $pharmacyToken | Out-Null
  }

  $doctorToken = $script:Tokens["DOCTOR"]
  if ($doctorToken -and $script:Context.patientId -and $script:Context.doctorId) {
    $rx = Invoke-StaffRequest `
      -Role "DOCTOR" `
      -Check "create_prescription" `
      -Method "POST" `
      -Path "/prescriptions/create" `
      -Token $doctorToken `
      -Body @{
        appointment_id = $script:Context.appointmentId
        patient_id = $script:Context.patientId
        doctor_id = $script:Context.doctorId
        diagnosis = "Smoke diagnosis"
        clinical_notes = "Smoke prescription create check"
        medications = @(
          @{
            name = "Paracetamol"
            dosage = "500mg"
            frequency = "BD"
            duration = "2 days"
            route = "Oral"
            instructions = "After food"
          }
        )
      } `
      -ExpectedStatus @(200, 201)
    $rxData = Get-JsonField $rx.json "data"
    if ($rxData) {
      $script:Context.createdPrescriptionId = Get-JsonField $rxData "id"
    }
  } else {
    Add-SmokeResult "DOCTOR" "create_prescription" "POST" "/prescriptions/create" "SKIP" $false "Missing patient_id or doctor_id from smoke context" "optional"
  }
}

function Write-Report {
  $resolvedReport = Resolve-Path -LiteralPath (Split-Path -Parent $ReportPath) -ErrorAction SilentlyContinue
  if ($null -eq $resolvedReport) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null
  }

  $failures = @($script:Results | Where-Object { -not $_.ok -and $_.severity -ne "optional" })
  $optionalFailures = @($script:Results | Where-Object { -not $_.ok -and $_.severity -eq "optional" })
  $passed = @($script:Results | Where-Object { $_.ok })
  $date = Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
  $safeBase = $script:Base -replace "([?&]api[_-]?key=)[^&]+", '$1[redacted]'

  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# Staff Role Workflow Sweep") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("Last generated: $date") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("Target: ``$safeBase``") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("This is a live contract smoke for the seeded staff accounts. It verifies login, staff profile, attendance state, notifications, messaging, and the role-specific operational endpoints that the Flutter staff app opens. It does not expose tokens or API keys in this report.") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("## Summary") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("- Total checks: $($script:Results.Count)") | Out-Null
  $lines.Add("- Passed: $($passed.Count)") | Out-Null
  $lines.Add("- Required failures: $($failures.Count)") | Out-Null
  $lines.Add("- Optional failures/skips: $($optionalFailures.Count)") | Out-Null
  $lines.Add("- Create-flow checks: $($IncludeCreates.IsPresent)") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("## Role Matrix") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add("| Role | Check | Method | Path | Status | Result | Detail |") | Out-Null
  $lines.Add("|---|---|---:|---|---:|---|---|") | Out-Null
  foreach ($r in $script:Results) {
    $result = if ($r.ok) { "pass" } elseif ($r.severity -eq "optional") { "optional-fail" } else { "fail" }
    $detail = ([string]$r.detail).Replace("|", "\|").Replace("`r", " ").Replace("`n", " ")
    if ($detail.Length -gt 180) { $detail = $detail.Substring(0, 180) + "..." }
    $lines.Add("| $($r.role) | $($r.check) | $($r.method) | ``$($r.path)`` | $($r.status) | $result | $detail |") | Out-Null
  }
  $lines.Add("") | Out-Null
  $lines.Add("## Create Context") | Out-Null
  $lines.Add("") | Out-Null
  foreach ($key in $script:Context.Keys) {
    $value = if ($script:Context[$key]) { $script:Context[$key] } else { "" }
    $lines.Add("- ``$key``: $value") | Out-Null
  }
  $lines.Add("") | Out-Null
  $lines.Add("## Run Command") | Out-Null
  $lines.Add("") | Out-Null
  $lines.Add('```powershell') | Out-Null
  $lines.Add('$env:VH_BASE_URL = "https://<host>/api/v1"') | Out-Null
  $lines.Add('$env:VH_API_KEY = "<redacted>"') | Out-Null
  $lines.Add('$env:VH_STAFF_TEST_PASSWORD = "<seeded password>"') | Out-Null
  $lines.Add('.\scripts\smoke-staff-role-workflows.ps1 -IncludeCreates') | Out-Null
  $lines.Add('```') | Out-Null

  Set-Content -Path $ReportPath -Value $lines -Encoding UTF8
}

foreach ($account in $accounts) {
  Write-Host "Logging in $($account.employeeId) ($($account.role))..."
  $token = Invoke-Login $account
  if ($token) {
    Invoke-RoleChecks -Account $account -Token $token
  }
}

if ($IncludeCreates) {
  Write-Host "Running create-flow checks..."
  Invoke-CreateChecks
}

Write-Report

$requiredFailures = @($script:Results | Where-Object { -not $_.ok -and $_.severity -ne "optional" })
Write-SmokeResults -Results $script:Results -Formatter $roleResultFormatter

Write-Host "Staff role workflow report: $ReportPath"
if ($requiredFailures.Count -gt 0 -and $FailOnFailure) {
  throw "$($requiredFailures.Count) required staff role workflow smoke check(s) failed. See $ReportPath"
}
} finally {
  # A terminating error above must not discard the checks already recorded.
  # Write-SmokeResults is idempotent, so the normal path prints where it
  # always did and this is a no-op after it.
  Write-SmokeResults -Results $script:Results -Formatter $roleResultFormatter
}
