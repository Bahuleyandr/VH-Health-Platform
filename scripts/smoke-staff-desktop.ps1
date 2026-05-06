<#
.SYNOPSIS
Runs the staff Flutter desktop smoke test against a live backend.

.DESCRIPTION
This wrapper executes the existing integration test that logs in as the
seeded SUPER_ADMIN staff account and opens the common dashboard surfaces.
Use it on Windows with a reachable backend and seeded test users.
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = $env:VH_BASE_URL,
  [string]$ApiKey = $env:VH_API_KEY,
  [string]$Device = "windows",
  [string]$StaffDir = (Join-Path $PSScriptRoot "..\apps\staff"),
  [bool]$DisableCrashlytics = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  throw "BaseUrl is required. Pass -BaseUrl or set VH_BASE_URL."
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "ApiKey is required. Pass -ApiKey or set VH_API_KEY."
}

if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
  throw "Required command not found: flutter"
}

Push-Location $StaffDir
try {
  $disableCrashlyticsValue = if ($DisableCrashlytics) { "true" } else { "false" }
  flutter test integration_test/staff_desktop_smoke_test.dart `
    -d $Device `
    --dart-define=VH_BASE_URL=$BaseUrl `
    --dart-define=VH_API_KEY=$ApiKey `
    --dart-define=VH_DISABLE_CRASHLYTICS=$disableCrashlyticsValue
  if ($LASTEXITCODE -ne 0) {
    throw "Staff desktop smoke failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
