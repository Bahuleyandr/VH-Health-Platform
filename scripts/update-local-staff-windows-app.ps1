<#
.SYNOPSIS
Builds and updates the local Windows Staff app without a reinstall.

.DESCRIPTION
This is the no-admin hands-on path for this PC. It builds the Flutter Windows
release, stops the running Staff app, copies the release files into a stable
per-user install directory, creates/refreshes the Start Menu shortcut, and
launches the app. Local app data is stored outside this install directory, so
overwriting the binaries does not clear logins or test state.
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = $env:VH_BASE_URL,
  [string]$ApiKey = $env:VH_API_KEY,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\VH Health Staff"),
  [switch]$SkipBuild,
  [switch]$SkipAnalyze,
  [switch]$NoLaunch,
  [switch]$AllowCustomInstallDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$staffDir = Join-Path $repoRoot "apps\staff"
$releaseDir = Join-Path $staffDir "build\windows\x64\runner\Release"
$defaultStableBaseUrl = "https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1"
$defaultInstallDir = [System.IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA "Programs\VH Health Staff")
)
$installFullPath = [System.IO.Path]::GetFullPath($InstallDir)

if (-not $AllowCustomInstallDir.IsPresent -and $installFullPath -ne $defaultInstallDir) {
  throw "Custom InstallDir requires -AllowCustomInstallDir because this script overwrites that directory."
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = $defaultStableBaseUrl
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  if ($BaseUrl -match '^https://dalekdefender\.hippocampus-monitor\.ts\.net:8444/') {
    throw "ApiKey is required for the DalekDefender backend. Set `$env:VH_API_KEY or pass -ApiKey. Refusing to build a remote app with the local dev key."
  }
  $ApiKey = "vhhealth-local-api-key"
}

if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
  throw "Required command not found: flutter"
}

Get-Process -Name "vhhealth_staff" -ErrorAction SilentlyContinue | Stop-Process -Force

if (-not $SkipBuild.IsPresent) {
  Push-Location $staffDir
  try {
    if (-not $SkipAnalyze.IsPresent) {
      flutter analyze --no-fatal-infos
      if ($LASTEXITCODE -ne 0) {
        throw "flutter analyze failed with exit code $LASTEXITCODE"
      }
    }

    flutter build windows --release `
      --dart-define=VH_BASE_URL=$BaseUrl `
      --dart-define=VH_API_KEY=$ApiKey `
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
if ($LASTEXITCODE -gt 7) {
  throw "robocopy failed with exit code $LASTEXITCODE"
}

$exePath = Join-Path $installFullPath "vhhealth_staff.exe"
$shortcutDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\VH Health"
New-Item -ItemType Directory -Force -Path $shortcutDir | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $shortcutDir "VH Health Staff.lnk"))
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $installFullPath
$shortcut.IconLocation = $exePath
$shortcut.Save()

if (-not $NoLaunch.IsPresent) {
  Start-Process -FilePath $exePath
}

Write-Host "VH Health Staff local app updated."
Write-Host "Install directory: $installFullPath"
Write-Host "Shortcut: $(Join-Path $shortcutDir "VH Health Staff.lnk")"
