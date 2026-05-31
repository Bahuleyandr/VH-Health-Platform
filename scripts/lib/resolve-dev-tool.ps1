function Get-UpwardToolPaths {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StartDir,

    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $paths = New-Object System.Collections.Generic.List[string]

  if ($env:FLUTTER_ROOT -and $RelativePath -like "Tools\flutter\bin\*") {
    $leafName = Split-Path -Leaf $RelativePath
    $paths.Add((Join-Path $env:FLUTTER_ROOT "bin\$leafName"))
  }

  $current = [System.IO.DirectoryInfo]::new(
    [System.IO.Path]::GetFullPath($StartDir)
  )
  while ($null -ne $current) {
    $paths.Add((Join-Path $current.FullName $RelativePath))
    $current = $current.Parent
  }

  return $paths.ToArray() | Select-Object -Unique
}

function Resolve-DevTool {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [string[]]$FallbackPaths = @()
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    if (-not [string]::IsNullOrWhiteSpace($command.Source)) {
      return $command.Source
    }
    return $command.Name
  }

  foreach ($path in $FallbackPaths) {
    if ([string]::IsNullOrWhiteSpace($path)) {
      continue
    }
    $expanded = [Environment]::ExpandEnvironmentVariables($path)
    if (Test-Path -LiteralPath $expanded) {
      return [System.IO.Path]::GetFullPath($expanded)
    }
  }

  $checked = $FallbackPaths |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -Unique
  if ($checked) {
    throw "Required command not found: $Name. Checked PATH and: $($checked -join '; ')"
  }
  throw "Required command not found: $Name"
}
