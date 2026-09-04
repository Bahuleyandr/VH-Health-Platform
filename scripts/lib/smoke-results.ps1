# Shared result reporting for the smoke and preflight scripts.
#
# Every one of these scripts accumulates its checks in a list and prints that
# list as the LAST statement of the script. That ordering is a mask. A
# terminating error anywhere in the body -- a [Parameter(Mandatory)] receiving
# $null, a helper that throws, an index past the end of a split -- skips the
# print and discards the diagnosis the script had ALREADY recorded.
#
# 2026-09-04 is what that costs. The Clinical AI pilot evidence smoke died on
#   Cannot bind argument to parameter 'Payload' because it is null.
# and reported not one of its checks. The failing request's status code and
# error body were sitting in the accumulator; the crash threw them away, and CI
# showed only the binding error. The preflight step behind it then failed for a
# missing pilot signoff that this script is the only thing that ever creates --
# a true report about a precondition, with its cause invisible one step above.
#
# Callers wrap their body in try/finally and report from the finally block, so
# the table survives the exception. Reporting is idempotent: the normal path
# still prints exactly where it always did, and the finally block is a no-op
# once that has happened.
#
# This does NOT convert a failure into a pass, which is the only way a change
# here could be worse than the bug. Verified against a faithful replica of the
# GitHub Actions pwsh wrapper ($ErrorActionPreference='stop' plus the
# LASTEXITCODE tail), try/finally leaves every exit code exactly as it was:
# unhandled error 1 -> 1, `exit 1` -> 1, clean run 0 -> 0.
#
# One constraint on the callers: the wrapper must NOT re-indent the script body.
# These scripts embed SQL and node snippets in here-strings, and a here-string's
# closing delimiter has to stay at column 0. PowerShell does not care about
# indentation, so `try {` and `} finally {` are added around the body at column
# 0 and every line between them keeps the indentation it already had.

$script:SmokeResultsReported = $false

function Write-SmokeResults {
  <#
    .SYNOPSIS
      Print the accumulated checks, at most once per script run.

    .PARAMETER Results
      The accumulator. Safe to pass $null or an empty list -- a script that
      dies before recording anything simply has nothing to report.

    .PARAMETER Formatter
      Optional scriptblock receiving the rows, for scripts that select or sort
      columns rather than dumping the object as-is.

    .PARAMETER Quiet
      Mark the results as reported WITHOUT printing them. For a script whose
      normal path deliberately emits something else instead (the preflight's
      -Json mode), so the finally block does not append a table to output a
      caller is parsing. The crash path still prints, which is the point.
  #>
  param(
    $Results,
    [scriptblock]$Formatter,
    [switch]$Quiet
  )

  if ($script:SmokeResultsReported) { return }
  $script:SmokeResultsReported = $true
  if ($Quiet) { return }

  if ($null -eq $Results) { return }
  $rows = @($Results)
  if ($rows.Count -eq 0) { return }

  # Out-String forces rendering to the host here rather than emitting format
  # objects into a pipeline that an exception is already tearing down.
  if ($Formatter) {
    & $Formatter $rows | Out-String | Write-Host
  } else {
    $rows | Format-Table -AutoSize | Out-String | Write-Host
  }
}
