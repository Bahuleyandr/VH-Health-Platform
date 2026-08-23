"use client";

import type {
  MigrationRehearsalReport,
  MigrationValidationFinding,
} from "@/lib/api/migrationToolkit";
import { CountGrid, JsonDetails, StatusPill, formatDateTime } from "./shared";

/**
 * Renders the latest rehearsal report exactly as the API returned it. The
 * backend redacts PHI before persisting (phi_redacted, message_redacted,
 * sample_rows_redacted) — this view must never re-derive or synthesize
 * values that the report does not carry.
 */
export function RehearsalReportView({
  report,
  findings,
}: {
  report: MigrationRehearsalReport;
  findings?: MigrationValidationFinding[];
}) {
  return (
    <div className="space-y-4" data-testid="rehearsal-report">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill value={report.status} />
        <span className="text-xs text-muted-foreground">
          Generated {formatDateTime(report.created_at)}
        </span>
        <span className="text-xs text-muted-foreground">
          PHI redacted: {report.phi_redacted ? "yes" : "no"}
        </span>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          Row counts
        </h4>
        <CountGrid entries={report.summary?.row_counts ?? {}} />
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          Validation findings by severity
        </h4>
        <CountGrid
          entries={{
            error: report.validation_summary?.by_severity?.error ?? 0,
            warning: report.validation_summary?.by_severity?.warning ?? 0,
            info: report.validation_summary?.by_severity?.info ?? 0,
          }}
        />
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          Duplicates
        </h4>
        <CountGrid entries={{ ...(report.duplicate_summary ?? {}) }} />
      </div>

      {(report.summary?.source_files?.length ?? 0) > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Source file</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Rows</th>
                <th className="px-3 py-2">SHA-256</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.summary.source_files.map((file) => (
                <tr key={file.id}>
                  <td className="px-3 py-2">{file.source_filename}</td>
                  <td className="px-3 py-2 text-xs">{file.file_kind}</td>
                  <td className="px-3 py-2 text-xs">{file.row_count}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {file.content_sha256?.slice(0, 16)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {findings && findings.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Row</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Field</th>
                <th className="px-3 py-2">Message (redacted)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {findings.slice(0, 100).map((finding) => (
                <tr key={finding.id}>
                  <td className="px-3 py-2 text-xs">{finding.source_row_number ?? "-"}</td>
                  <td className="px-3 py-2">
                    <StatusPill value={finding.severity} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{finding.finding_code}</td>
                  <td className="px-3 py-2 text-xs">{finding.field_name ?? "-"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {finding.message_redacted}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {findings.length > 100 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Showing first 100 of {findings.length} findings.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <JsonDetails label="No-write proof (dry-run evidence)" value={report.no_write_proof} />
        <JsonDetails label="Validation findings by code" value={report.validation_summary?.by_code} />
      </div>
    </div>
  );
}
