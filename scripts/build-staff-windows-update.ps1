<#
.SYNOPSIS
Builds a Windows MSIX/App Installer update for the VH Health Staff app.

.DESCRIPTION
The Staff app should be installed once as MSIX, then updated in place by
installing a package with the same identity and a higher semantic version.
By default this script bumps the app patch/build version before packaging.
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = $env:VH_BASE_URL,
  [string]$ApiKey = $env:VH_API_KEY,
  [string]$PublishFolder = (Join-Path $env:USERPROFILE "VH Health Staff Updates"),
  [string]$Version,
  [switch]$NoVersionBump,
  [switch]$SkipAnalyze,
  [switch]$Install,
  [switch]$Launch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\resolve-dev-tool.ps1")
$staffDir = Join-Path $repoRoot "apps\staff"
$pubspecPath = Join-Path $staffDir "pubspec.yaml"
$msixTestCertificatePath = Join-Path $env:LOCALAPPDATA "Pub\Cache\hosted\pub.dev\msix-3.16.13\lib\assets\test_certificate.pfx"
$defaultStableBaseUrl = "https://dalekdefender.hippocampus-monitor.ts.net:8444/api/v1"

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = $defaultStableBaseUrl
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  if ($BaseUrl -match '^https://dalekdefender\.hippocampus-monitor\.ts\.net:8444/') {
    throw "ApiKey is required for the DalekDefender backend. Set `$env:VH_API_KEY or pass -ApiKey. Refusing to package a remote app with the local dev key."
  }
  $ApiKey = "vhhealth-local-api-key"
}

$flutterCommand = Resolve-DevTool `
  -Name "flutter" `
  -FallbackPaths (Get-UpwardToolPaths -StartDir $repoRoot -RelativePath "Tools\flutter\bin\flutter.bat")
$flutterBinDir = Split-Path -Parent $flutterCommand
$dartCommand = Resolve-DevTool `
  -Name "dart" `
  -FallbackPaths @((Join-Path $flutterBinDir "dart.bat"))

Get-Process -Name "vhhealth_staff" -ErrorAction SilentlyContinue | Stop-Process -Force

function Set-StaffAppVersion {
  param(
    [string]$Path,
    [string]$RequestedVersion,
    [bool]$ShouldBump
  )

  $content = Get-Content -LiteralPath $Path -Raw
  $match = [regex]::Match($content, "(?m)^version:\s+(\d+)\.(\d+)\.(\d+)\+(\d+)\s*$")
  if (-not $match.Success) {
    throw "Could not find a version like 'version: 1.0.0+1' in $Path"
  }

  $currentVersion = $match.Value -replace "^version:\s+", ""
  if (-not [string]::IsNullOrWhiteSpace($RequestedVersion)) {
    if ($RequestedVersion -notmatch "^\d+\.\d+\.\d+\+\d+$") {
      throw "Version must be in Flutter semver form, for example 1.0.2+3"
    }
    $nextVersion = $RequestedVersion
  } elseif ($ShouldBump) {
    $major = [int]$match.Groups[1].Value
    $minor = [int]$match.Groups[2].Value
    $patch = [int]$match.Groups[3].Value + 1
    $build = [int]$match.Groups[4].Value + 1
    $nextVersion = "$major.$minor.$patch+$build"
  } else {
    $nextVersion = $currentVersion
  }

  if ($nextVersion -ne $currentVersion) {
    $updated = [regex]::Replace(
      $content,
      "(?m)^version:\s+\d+\.\d+\.\d+\+\d+\s*$",
      "version: $nextVersion",
      1
    )
    Set-Content -LiteralPath $Path -Value $updated -NoNewline
  }

  return $nextVersion
}

function Test-IsElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$shouldBump = -not $NoVersionBump.IsPresent -or -not [string]::IsNullOrWhiteSpace($Version)
$resolvedVersion = Set-StaffAppVersion `
  -Path $pubspecPath `
  -RequestedVersion $Version `
  -ShouldBump $shouldBump

New-Item -ItemType Directory -Force -Path $PublishFolder | Out-Null
$appInstallerPath = Join-Path $PublishFolder "VHHealthStaff.appinstaller"
if ($NoVersionBump.IsPresent -and (Test-Path -LiteralPath $appInstallerPath)) {
  Remove-Item -LiteralPath $appInstallerPath -Force
}

Push-Location $staffDir
try {
  & $dartCommand pub get
  if ($LASTEXITCODE -ne 0) {
    throw "dart pub get failed with exit code $LASTEXITCODE"
  }

  if (-not $SkipAnalyze.IsPresent) {
    & $flutterCommand analyze --no-fatal-infos
    if ($LASTEXITCODE -ne 0) {
      throw "flutter analyze failed with exit code $LASTEXITCODE"
    }
  }

  $windowsBuildArgs = @(
    "--dart-define=VH_BASE_URL=$BaseUrl"
    ("--dart-define=VH_API_" + "KEY=$ApiKey")
    "--dart-define=VH_DISABLE_CRASHLYTICS=true"
  ) -join " "
  & $dartCommand run msix:publish `
    --publish-folder-path $PublishFolder `
    --install-certificate false `
    --windows-build-args $windowsBuildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "dart run msix:publish failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$appInstaller = Get-ChildItem -LiteralPath $PublishFolder -Recurse -Filter "*.appinstaller" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$msix = Get-ChildItem -LiteralPath $PublishFolder -Recurse -Filter "*.msix" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $appInstaller -and -not $msix) {
  $msix = Get-ChildItem -LiteralPath (Join-Path $staffDir "build\windows") -Recurse -Filter "*.msix" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

if (-not $appInstaller -and -not $msix) {
  throw "No MSIX/App Installer output was found under $PublishFolder or the Staff build folder"
}

if ($Install.IsPresent) {
  Get-Process -Name "vhhealth_staff" -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Test-Path -LiteralPath $msixTestCertificatePath) {
    if (-not (Test-IsElevated)) {
      throw "MSIX -Install uses the local test certificate and requires an elevated PowerShell window. For no-admin local updates, run scripts\update-local-staff-windows-app.ps1 instead."
    }
    $certificatePassword = ConvertTo-SecureString "1234" -AsPlainText -Force
    Import-PfxCertificate `
      -FilePath $msixTestCertificatePath `
      -CertStoreLocation "Cert:\LocalMachine\Root" `
      -Password $certificatePassword | Out-Null
  }
  if ($appInstaller) {
    Add-AppxPackage -AppInstallerFile $appInstaller.FullName
  } else {
    Add-AppxPackage -Path $msix.FullName
  }
}

if ($Launch.IsPresent) {
  $startApp = Get-StartApps |
    Where-Object { $_.Name -eq "VH Health Staff" } |
    Select-Object -First 1
  if ($startApp) {
    Start-Process explorer.exe "shell:AppsFolder\$($startApp.AppID)"
  } else {
    Write-Warning "VH Health Staff was not found in Start apps. Open it once from Start after install."
  }
}

Write-Host "Staff Windows update package ready."
Write-Host "Version: $resolvedVersion"
if ($appInstaller) {
  Write-Host "App Installer: $($appInstaller.FullName)"
}
if ($msix) {
  Write-Host "MSIX: $($msix.FullName)"
}
