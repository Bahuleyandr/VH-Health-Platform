<#
.SYNOPSIS
Builds and updates the local Windows Staff app without a reinstall.

.DESCRIPTION
This is the no-admin hands-on path for this PC. It builds the Flutter Windows
release, stops the running Staff app, copies the release files into a stable
D:\Dev\Tools install directory, and launches the app. Local app data is stored
outside this install directory, so overwriting the binaries does not clear
logins or test state.
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = $env:VH_BASE_URL,
  [string]$ApiKey = $env:VH_API_KEY,
  [string]$SentryDsn = $env:VH_SENTRY_DSN,
  [string]$SentryEnvironment = $env:VH_SENTRY_ENVIRONMENT,
  [string]$SentryRelease = $env:VH_SENTRY_RELEASE,
  [string]$InstallDir = "D:\Dev\Tools\VH Health Staff",
  [switch]$SkipBuild,
  [switch]$SkipAnalyze,
  [switch]$SkipApiKeyPreflight,
  [switch]$NoLaunch,
  [switch]$CreateShortcuts,
  [switch]$NoDesktopShortcut,
  [switch]$AllowCustomInstallDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\resolve-dev-tool.ps1")
$staffDir = Join-Path $repoRoot "apps\staff"
$releaseDir = Join-Path $staffDir "build\windows\x64\runner\Release"
$defaultStableBaseUrl = "https://api.vhhealth.app/api/v1"
$defaultInstallDir = [System.IO.Path]::GetFullPath(
  "D:\Dev\Tools\VH Health Staff"
)
$installFullPath = [System.IO.Path]::GetFullPath($InstallDir)

if (-not $AllowCustomInstallDir.IsPresent -and $installFullPath -ne $defaultInstallDir) {
  throw "Custom InstallDir requires -AllowCustomInstallDir because this script overwrites that directory."
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = $defaultStableBaseUrl
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  if ($BaseUrl -notmatch '^https?://(127\.0\.0\.1|localhost)(:\d+)?(/|$)') {
    throw "ApiKey is required for the remote VH Health backend. Set `$env:VH_API_KEY or pass -ApiKey. Refusing to build a remote app with the local dev key."
  }
  $ApiKey = "vhhealth-local-api-key"
}

if ([string]::IsNullOrWhiteSpace($SentryDsn)) {
  $SentryDsn = $env:SENTRY_DSN
}
if ([string]::IsNullOrWhiteSpace($SentryEnvironment)) {
  $SentryEnvironment = if ([string]::IsNullOrWhiteSpace($env:SENTRY_ENVIRONMENT)) {
    "local-windows"
  } else {
    $env:SENTRY_ENVIRONMENT
  }
}
if ([string]::IsNullOrWhiteSpace($SentryRelease)) {
  $SentryRelease = $env:SENTRY_RELEASE
}

function Test-RemoteApiKeyPreflight {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$ApiKey
  )

  if ($BaseUrl -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?(/|$)') {
    return
  }

  $preflightUrl = "$($BaseUrl.TrimEnd('/'))/departments"
  $statusCode = $null
  $body = ''

  try {
    $requestArgs = @{
      Uri = $preflightUrl
      Headers = @{ 'x-api-key' = $ApiKey }
      UseBasicParsing = $true
      TimeoutSec = 20
      ErrorAction = 'Stop'
    }
    if ($PSVersionTable.PSVersion.Major -ge 7) {
      $requestArgs['SkipHttpErrorCheck'] = $true
    }

    $response = Invoke-WebRequest @requestArgs
    $statusCode = [int]$response.StatusCode
    $body = [string]$response.Content
  } catch {
    $response = $null
    if ($_.Exception.PSObject.Properties.Match('Response').Count -gt 0) {
      $response = $_.Exception.Response
    }
    if (-not $response) {
      throw "Remote API key preflight failed before build: $($_.Exception.Message)"
    }

    $statusCode = [int]$response.StatusCode
    if ($response.PSObject.TypeNames -contains 'System.Net.Http.HttpResponseMessage') {
      $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    } elseif ($response.GetResponseStream) {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try {
        $body = $reader.ReadToEnd()
      } finally {
        $reader.Dispose()
      }
    } elseif ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $body = $_.ErrorDetails.Message
    }
  }

  if ($body -match 'Invalid API Key') {
    throw "Remote API key preflight failed for ${BaseUrl}: backend rejected the supplied key as Invalid API Key. Use the live deployment secret before rebuilding Staff."
  }

  if ($body -match 'Missing API Key') {
    throw "Remote API key preflight failed for ${BaseUrl}: no API key reached the backend."
  }

  if ($statusCode -eq 401 -and $body -match 'Authorization header missing or invalid') {
    Write-Host "Remote API key preflight passed for $BaseUrl (API key accepted; JWT required)."
    return
  }

  if ($statusCode -ge 200 -and $statusCode -lt 500) {
    Write-Host "Remote API key preflight passed for $BaseUrl (HTTP $statusCode)."
    return
  }

  throw "Remote API key preflight failed for $BaseUrl with HTTP $statusCode."
}

if (-not $SkipApiKeyPreflight.IsPresent) {
  Test-RemoteApiKeyPreflight -BaseUrl $BaseUrl -ApiKey $ApiKey
}

$flutterCommand = Resolve-DevTool `
  -Name "flutter" `
  -FallbackPaths (Get-UpwardToolPaths -StartDir $repoRoot -RelativePath "Tools\flutter\bin\flutter.bat")

Get-Process -Name "vhhealth_staff" -ErrorAction SilentlyContinue | Stop-Process -Force

if (-not $SkipBuild.IsPresent) {
  Push-Location $staffDir
  try {
    if (-not $SkipAnalyze.IsPresent) {
      & $flutterCommand analyze --no-fatal-infos
      if ($LASTEXITCODE -ne 0) {
        throw "flutter analyze failed with exit code $LASTEXITCODE"
      }
    }

    & $flutterCommand build windows --release `
      --dart-define=VH_BASE_URL=$BaseUrl `
      --dart-define=VH_API_KEY=$ApiKey `
      --dart-define=SENTRY_DSN=$SentryDsn `
      --dart-define=SENTRY_ENVIRONMENT=$SentryEnvironment `
      --dart-define=SENTRY_RELEASE=$SentryRelease `
      --dart-define=VH_DISABLE_CRASHLYTICS=true
    if ($LASTEXITCODE -ne 0) {
      throw "flutter build windows failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $releaseDir "vhhealth_staff.exe"))) {
  throw "Staff release executable not found. Expected: $(Join-Path $releaseDir "vhhealth_staff.exe")"
}

Get-Process -Name "vhhealth_staff" -ErrorAction SilentlyContinue | Stop-Process -Force
New-Item -ItemType Directory -Force -Path $installFullPath | Out-Null

robocopy $releaseDir $installFullPath /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
$robocopyExitCode = $LASTEXITCODE
if ($robocopyExitCode -gt 7) {
  throw "robocopy failed with exit code $robocopyExitCode"
}
$global:LASTEXITCODE = 0

$exePath = Join-Path $installFullPath "vhhealth_staff.exe"
$desktopShortcutPath = $null
if ($CreateShortcuts.IsPresent) {
  $shortcutDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\VH Health"
  New-Item -ItemType Directory -Force -Path $shortcutDir | Out-Null

  $shell = New-Object -ComObject WScript.Shell
  $shortcutPath = Join-Path $shortcutDir "VH Health Staff.lnk"
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $exePath
  $shortcut.WorkingDirectory = $installFullPath
  $shortcut.IconLocation = $exePath
  $shortcut.Save()

  if (-not $NoDesktopShortcut.IsPresent) {
    $desktopDir = [Environment]::GetFolderPath("Desktop")
    if (-not [string]::IsNullOrWhiteSpace($desktopDir)) {
      $desktopShortcutPath = Join-Path $desktopDir "VH Health Staff.lnk"
      $desktopShortcut = $shell.CreateShortcut($desktopShortcutPath)
      $desktopShortcut.TargetPath = $exePath
      $desktopShortcut.WorkingDirectory = $installFullPath
      $desktopShortcut.IconLocation = $exePath
      $desktopShortcut.Save()
    }
  }
}

if (-not $NoLaunch.IsPresent) {
  Start-Process -FilePath $exePath
}

Write-Host "VH Health Staff local app updated."
Write-Host "Install directory: $installFullPath"
if ($CreateShortcuts.IsPresent) {
  Write-Host "Shortcut: $shortcutPath"
}
if ($desktopShortcutPath) {
  Write-Host "Desktop shortcut: $desktopShortcutPath"
}
