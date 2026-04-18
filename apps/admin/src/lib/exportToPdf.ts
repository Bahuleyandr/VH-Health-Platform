// src/lib/exportToPdf.ts
//
// Thin wrapper over jsPDF + jspdf-autotable for dashboard exports (compliance
// indicators, executive KPI, denial summaries). Each export lays down a
// common header (hospital name, title, trailing-window timestamp) then renders
// an autotable from `rows`. Consumers pass plain JS arrays — no jsPDF knowledge
// required at the call site.
//
// Dynamic import keeps the ~300kb jsPDF bundle out of the initial page load.

export type PdfTable = {
  title: string;
  head: string[];
  rows: (string | number | null | undefined)[][];
};

export type PdfExportOptions = {
  filename: string;
  /** Header line under the hospital name — e.g. "Compliance indicators". */
  title: string;
  /** Optional subtitle line — e.g. "Trailing 30 days · generated 2026-04-14". */
  subtitle?: string;
  tables: PdfTable[];
  /** Optional KPI tile strip rendered between subtitle and the first table. */
  kpis?: { label: string; value: string }[];
};

const HOSPITAL = 'Venkataeswara Hospital · VH Health';

export async function exportToPdf(opts: PdfExportOptions): Promise<void> {
  const { jsPDF } = await import('jspdf');
  // jspdf-autotable patches jsPDF.prototype — the default import registers.
  await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(HOSPITAL, margin, 50);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(opts.title, margin, 70);
  if (opts.subtitle) {
    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text(opts.subtitle, margin, 86);
    doc.setTextColor(0);
  }

  let cursorY = opts.subtitle ? 104 : 90;

  // KPI strip
  if (opts.kpis && opts.kpis.length) {
    const boxW = (pageWidth - margin * 2) / opts.kpis.length;
    opts.kpis.forEach((k, i) => {
      const x = margin + i * boxW;
      doc.setDrawColor(200);
      doc.rect(x, cursorY, boxW - 4, 48);
      doc.setFontSize(8);
      doc.setTextColor(100);
      doc.text(k.label, x + 6, cursorY + 14);
      doc.setFontSize(14);
      doc.setTextColor(0);
      doc.setFont('helvetica', 'bold');
      doc.text(k.value, x + 6, cursorY + 36);
      doc.setFont('helvetica', 'normal');
    });
    cursorY += 64;
  }

  // Tables
  // Use loose typing here: jspdf-autotable monkey-patches jsPDF so `autoTable`
  // exists at runtime but isn't in jsPDF's d.ts. Casting to any is the standard
  // workaround for this library.
  type AutoTableFn = (options: unknown) => void;
  const autoTable = (doc as unknown as { autoTable: AutoTableFn }).autoTable.bind(doc);

  for (const table of opts.tables) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(table.title, margin, cursorY);
    cursorY += 6;
    autoTable({
      head: [table.head],
      body: table.rows.map((r) => r.map((c) => (c == null ? '' : String(c)))),
      startY: cursorY + 4,
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [45, 45, 55] },
      margin: { left: margin, right: margin },
    });
    // jspdf-autotable stashes the finished Y coord on the doc instance.
    const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY;
    cursorY = (finalY ?? cursorY) + 24;
  }

  // Footer with generated-at timestamp on the last page.
  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(
    `Generated ${new Date().toLocaleString("en-IN")}`,
    margin,
    doc.internal.pageSize.getHeight() - 20,
  );

  doc.save(opts.filename);
}
