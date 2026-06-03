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
  [string]$SentryDsn = $env:VH_SENTRY_DSN,
  [string]$SentryEnvironment = $env:VH_SENTRY_ENVIRONMENT,
  [string]$SentryRelease = $env:VH_SENTRY_RELEASE,
  [string]$Device = "windows",
  [string]$StaffDir = (Join-Path $PSScriptRoot "..\apps\staff"),
  [bool]$DisableCrashlytics = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\resolve-dev-tool.ps1")

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  throw "BaseUrl is required. Pass -BaseUrl or set VH_BASE_URL."
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "ApiKey is required. Pass -ApiKey or set VH_API_KEY."
}

if ([string]::IsNullOrWhiteSpace($SentryDsn)) {
  $SentryDsn = $env:SENTRY_DSN
}
if ([string]::IsNullOrWhiteSpace($SentryEnvironment)) {
  $SentryEnvironment = if ([string]::IsNullOrWhiteSpace($env:SENTRY_ENVIRONMENT)) {
    "staff-desktop-smoke"
  } else {
    $env:SENTRY_ENVIRONMENT
  }
}
if ([string]::IsNullOrWhiteSpace($SentryRelease)) {
  $SentryRelease = $env:SENTRY_RELEASE
}

$flutterCommand = Resolve-DevTool `
  -Name "flutter" `
  -FallbackPaths (Get-UpwardToolPaths -StartDir $repoRoot -RelativePath "Tools\flutter\bin\flutter.bat")

Push-Location $StaffDir
try {
  $disableCrashlyticsValue = if ($DisableCrashlytics) { "true" } else { "false" }
  & $flutterCommand test integration_test/staff_desktop_smoke_test.dart `
    -d $Device `
    --dart-define=VH_BASE_URL=$BaseUrl `
    --dart-define=VH_API_KEY=$ApiKey `
    --dart-define=SENTRY_DSN=$SentryDsn `
    --dart-define=SENTRY_ENVIRONMENT=$SentryEnvironment `
    --dart-define=SENTRY_RELEASE=$SentryRelease `
    --dart-define=VH_DISABLE_CRASHLYTICS=$disableCrashlyticsValue
  if ($LASTEXITCODE -ne 0) {
    throw "Staff desktop smoke failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
