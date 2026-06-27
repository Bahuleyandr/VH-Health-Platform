#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Refresh the codebase-memory-mcp knowledge graphs for the VH Health monorepo.

.DESCRIPTION
  Indexes one project per stack so name-based call resolution stays accurate
  (a single monorepo blob cross-links Dart <-> React/JS by bare name):

    backend  -> apps/backend          (JS  - method-level call graph)
    admin    -> apps/admin            (React/TSX)
    patient  -> apps/patient/lib      (Dart - lib/ only; native/plugin dirs are noise)
    staff    -> apps/staff/lib        (Dart - lib/ only)
    core     -> packages/vhhealth_core(Dart shared)
    monorepo -> <repo root>           (whole repo, ephemeral-free, for cross-cutting search)

  Default run is INCREMENTAL (only changed files are re-extracted - fast).
  Use -Clean for a full delete+rebuild (required after editing .cbmignore rules,
  since incremental indexing does not purge files that just became ignored).

.PARAMETER Only
  Subset of stacks, e.g. -Only backend,patient. Default: all.

.PARAMETER Clean
  Delete each target project before reindexing (full clean rebuild).

.EXAMPLE
  ./scripts/codebase-memory-reindex.ps1
  ./scripts/codebase-memory-reindex.ps1 -Only backend
  ./scripts/codebase-memory-reindex.ps1 -Clean
#>
[CmdletBinding()]
param(
  [ValidateSet('backend','admin','patient','staff','core','monorepo')]
  [string[]]$Only,
  [switch]$Clean,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'

# Resolve the real native binary (avoids the npm/.ps1 shim so it works from git hooks too).
$exe = Join-Path (npm root -g) 'codebase-memory-mcp/bin/codebase-memory-mcp.exe'
if (-not (Test-Path $exe)) { throw "codebase-memory-mcp not found at $exe  (run: npm i -g codebase-memory-mcp)" }

# Repo root = parent of this script's folder, forward-slashed (JSON-safe even with the space in 'VH Health').
$repo = (Split-Path $PSScriptRoot -Parent) -replace '\\','/'

$targets = @(
  @{ label='backend';  path="$repo/apps/backend" }
  @{ label='admin';    path="$repo/apps/admin" }
  @{ label='patient';  path="$repo/apps/patient/lib" }
  @{ label='staff';    path="$repo/apps/staff/lib" }
  @{ label='core';     path="$repo/packages/vhhealth_core" }
  @{ label='monorepo'; path=$repo }
)
if ($Only) { $targets = @($targets | Where-Object { $Only -contains $_.label }) }

function Invoke-Cbm([string]$tool, [hashtable]$payload) {
  & $exe cli $tool ($payload | ConvertTo-Json -Compress) 2>$null
}

$rows = foreach ($t in $targets) {
  if (-not (Test-Path $t.path)) {
    [PSCustomObject]@{ Stack=$t.label; Nodes=$null; Edges=$null; Seconds=$null; Status='MISSING-PATH' }
    continue
  }
  # Project name is the absolute path slug (':' dropped, '/' and ' ' -> '-').
  $slug = ($t.path -replace ':','') -replace '[/ ]','-'
  if ($Clean) { Invoke-Cbm 'delete_project' @{ project = $slug } | Out-Null }

  $sw  = [System.Diagnostics.Stopwatch]::StartNew()
  $out = Invoke-Cbm 'index_repository' @{ repo_path = $t.path }
  $sw.Stop()

  $res = $null
  try { $res = ($out | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1 | ConvertFrom-Json) } catch {}
  [PSCustomObject]@{
    Stack   = $t.label
    Nodes   = $res.nodes
    Edges   = $res.edges
    Seconds = [math]::Round($sw.Elapsed.TotalSeconds,1)
    Status  = if ($res) { 'ok' } else { 'FAILED' }
  }
}

if (-not $Quiet) { $rows | Format-Table Stack,Nodes,Edges,Seconds,Status -AutoSize }
$mode = if ($Clean) { 'clean rebuild' } else { 'incremental' }
$secs = [math]::Round((($rows | Where-Object { $null -ne $_.Seconds }).Seconds | Measure-Object -Sum).Sum, 1)
Write-Output ("codebase-memory: refreshed {0} project(s) in {1}s ({2})" -f $rows.Count, $secs, $mode)
if ($rows.Status -contains 'FAILED') { exit 1 }
