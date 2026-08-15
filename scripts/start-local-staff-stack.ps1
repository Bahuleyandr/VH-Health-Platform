<#
.SYNOPSIS
Starts the local VH Health Staff hands-on stack.

.DESCRIPTION
Brings the local QA Postgres cluster online, starts the backend on port 5206
when it is not already healthy, waits for the API health route, then launches
the per-user Windows Staff app. This is intended for local hands-on testing so
the Staff app can be updated normally without reinstalling or reseeding data.
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = $env:VH_BASE_URL,
  [int]$BackendPort = 5206,
  [int]$WaitSeconds = 60,
  # Default matches the install directory update-local-staff-windows-app.ps1
  # writes to (see apps/staff/docs/WINDOWS_UPDATE_PACKAGES.md).
  [string]$StaffExe = "D:\Dev\Tools\VH Health Staff\vhhealth_staff.exe",
  [switch]$NoLaunch,
  [switch]$ForceRestartBackend
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot "apps\backend"
$healthUrl = "http://127.0.0.1:$BackendPort/api/v1/health"

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://127.0.0.1:$BackendPort/api/v1"
}

function Test-ApiHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $healthUrl
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Get-BackendListeners {
  Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
}

function Start-Backend {
  $logPath = Join-Path $backendDir "backend-local-stack.log"
  $errPath = Join-Path $backendDir "backend-local-stack.err.log"
  $command = @"
Set-Location -LiteralPath '$backendDir'
`$env:PORT = '$BackendPort'
`$env:VH_BASE_URL = '$BaseUrl'
npm start
"@

  if (Test-Path -LiteralPath $logPath) {
    Remove-Item -LiteralPath $logPath -Force
  }
  if (Test-Path -LiteralPath $errPath) {
    Remove-Item -LiteralPath $errPath -Force
  }

  Start-Process -FilePath "powershell.exe" `
    -WindowStyle Hidden `
    -WorkingDirectory $backendDir `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
    -RedirectStandardOutput $logPath `
    -RedirectStandardError $errPath | Out-Null

  Write-Host "Started backend process. Logs:"
  Write-Host "  $logPath"
  Write-Host "  $errPath"
}

function Stop-BackendListener {
  $listeners = Get-BackendListeners
  foreach ($listener in $listeners) {
    if ($listener.OwningProcess -and $listener.OwningProcess -ne 0) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
      $commandLine = if ($process) { [string]$process.CommandLine } else { "" }
      if ($commandLine -like "*apps*backend*" -or $commandLine -like "*src*bin*www.js*" -or $commandLine -like "*nodemon*") {
        Stop-Process -Id $listener.OwningProcess -Force
      } else {
        throw "Port $BackendPort is in use by PID $($listener.OwningProcess), but it does not look like the VH backend."
      }
    }
  }
}

Write-Host "Ensuring local QA Postgres is running..."
Push-Location $repoRoot
try {
  node apps/backend/scripts/qa-cluster-up.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "qa-cluster-up failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

if ($ForceRestartBackend.IsPresent) {
  Write-Host "Restarting backend listener on port $BackendPort..."
  Stop-BackendListener
  Start-Sleep -Seconds 2
}

if (-not (Test-ApiHealth)) {
  $listeners = Get-BackendListeners
  if ($listeners) {
    Write-Host "Port $BackendPort is listening but health is not ready yet."
  } else {
    Write-Host "Backend is not listening on port $BackendPort. Starting it..."
    Start-Backend
  }
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-ApiHealth) {
    Write-Host "Backend healthy: $healthUrl"
    if (-not $NoLaunch.IsPresent) {
      if (Test-Path -LiteralPath $StaffExe) {
        Start-Process -FilePath $StaffExe
        Write-Host "Launched Staff app: $StaffExe"
      } else {
        Write-Warning "Staff app not found at $StaffExe"
        Write-Host "Run scripts\update-local-staff-windows-app.ps1 first to build/update it."
      }
    }
    exit 0
  }
  Start-Sleep -Seconds 2
}

throw "Backend did not become healthy at $healthUrl within $WaitSeconds seconds."
