// Shared CSV export utility for admin data tables.
//
// Usage:
//   exportToCsv({
//     filename: "appointments.csv",
//     columns: [
//       { header: "Date", accessor: (row) => row.date },
//       { header: "Patient", accessor: (row) => row.patient_name },
//       { header: "Doctor", accessor: (row) => row.doctor_name },
//     ],
//     rows: appointments,
//   });

export interface CsvColumn<T> {
  header: string;
  accessor: (row: T) => string | number | boolean | null | undefined;
}

export interface CsvExportOptions<T> {
  filename: string;
  columns: CsvColumn<T>[];
  rows: T[];
  /** Optional BOM for Excel UTF-8 compatibility (default: true). */
  bom?: boolean;
}

/**
 * Escape a single CSV field: wrap in double quotes and double any embedded
 * quotes if the value contains a comma, quote, or newline.
 */
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  // CSV/formula injection guard: a leading =, +, -, @, tab or CR makes
  // Excel/Sheets evaluate the cell as a formula (e.g. =WEBSERVICE(...),
  // =cmd|'/C calc'!A1). Prefix with a single quote so spreadsheet apps treat
  // it as literal text. Fields here can carry user/PHI input (names, comments,
  // audit strings).
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  const needsQuoting =
    str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r");
  if (!needsQuoting) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Build a CSV string from rows + column accessors.
 * Exported separately so callers can get the string (e.g. for tests or
 * server-side use) without triggering a browser download.
 */
export function buildCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCsvField(c.header)).join(","));
  for (const row of rows) {
    lines.push(
      columns.map((c) => escapeCsvField(c.accessor(row))).join(","),
    );
  }
  // CRLF is what RFC 4180 + Excel prefer.
  return lines.join("\r\n");
}

/**
 * Trigger a browser download of the given rows as a CSV file. Must be called
 * from a user-initiated event (click handler) — browsers block programmatic
 * downloads otherwise.
 */
export function exportToCsv<T>({
  filename,
  columns,
  rows,
  bom = true,
}: CsvExportOptions<T>): void {
  if (typeof window === "undefined") {
    throw new Error("exportToCsv must be called in the browser");
  }

  const csv = buildCsv(columns, rows);
  const prefix = bom ? "\uFEFF" : ""; // UTF-8 BOM for Excel
  const blob = new Blob([prefix + csv], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the blob URL asynchronously to give the click handler time
  // to start the download before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
