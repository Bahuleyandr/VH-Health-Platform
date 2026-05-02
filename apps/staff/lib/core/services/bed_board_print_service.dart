import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

/// Renders a printable A4 occupancy sheet for the current bed-board view
/// and shows the platform print dialog. Indian hospital wards still rely
/// on printed handover sheets at shift change; this gives the staff app
/// a "Print" button that doesn't require routing through an admin page.
///
/// Caller passes:
///   - [wardName]: the human-readable ward name (rendered in the header)
///   - [beds]:     the same map list rendered on the bed grid (raw JSON
///                 from `/api/v1/beds/ward/:id`). The service pulls bed
///                 number, status, patient name, patient age, admitted-at,
///                 and notes — same fields the on-screen card displays.
class BedBoardPrintService {
  BedBoardPrintService._();

  static Future<void> print({
    required String wardName,
    required List<Map<String, dynamic>> beds,
  }) async {
    final pdf = pw.Document();
    final now = DateTime.now();
    final dateStr = DateFormat('EEE, d MMM yyyy · HH:mm').format(now);

    // Sort beds by bed_number so the printout matches what the eye
    // expects on a paper handover sheet (lexicographic, "A-101" before
    // "A-102").
    final sorted = [...beds]..sort(
      (a, b) {
        final an = (a['bed_number'] ?? a['bedNumber'] ?? '').toString();
        final bn = (b['bed_number'] ?? b['bedNumber'] ?? '').toString();
        return an.compareTo(bn);
      },
    );

    final headers = ['Bed', 'Status', 'Patient', 'Age', 'Admitted', 'Notes'];
    final rows = sorted.map((bed) {
      final bedNum =
          (bed['bed_number'] ?? bed['bedNumber'] ?? '—').toString();
      final status = (bed['status'] ?? '').toString();
      final patient = (bed['patient_full_name'] ??
              bed['patient_name'] ??
              bed['patientName'] ??
              '')
          .toString();
      final age = bed['patient_age'];
      final admitted = bed['admission_admitted_at'] ?? bed['admitted_at'];
      final notes = (bed['notes'] ?? '').toString();
      return [
        bedNum,
        _capitalize(status),
        patient.isEmpty ? '—' : patient,
        (age == null || age.toString().isEmpty) ? '—' : age.toString(),
        admitted == null
            ? '—'
            : _shortDate(admitted.toString()),
        notes.isEmpty ? '—' : _truncate(notes, 80),
      ];
    }).toList();

    final summary = _summarise(sorted);

    pdf.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        margin: const pw.EdgeInsets.all(28),
        header: (ctx) => _buildHeader(wardName, dateStr, summary),
        footer: (ctx) => _buildFooter(ctx),
        build: (ctx) => [
          pw.SizedBox(height: 8),
          pw.TableHelper.fromTextArray(
            headers: headers,
            data: rows,
            cellStyle: const pw.TextStyle(fontSize: 9),
            headerStyle: pw.TextStyle(
              fontSize: 9,
              fontWeight: pw.FontWeight.bold,
              color: PdfColors.white,
            ),
            headerDecoration: const pw.BoxDecoration(color: PdfColors.blue900),
            cellAlignment: pw.Alignment.centerLeft,
            cellAlignments: const {
              0: pw.Alignment.centerLeft,
              1: pw.Alignment.centerLeft,
              2: pw.Alignment.centerLeft,
              3: pw.Alignment.centerRight,
              4: pw.Alignment.centerLeft,
              5: pw.Alignment.centerLeft,
            },
            columnWidths: const {
              0: pw.FixedColumnWidth(48),
              1: pw.FixedColumnWidth(60),
              2: pw.FlexColumnWidth(2.2),
              3: pw.FixedColumnWidth(38),
              4: pw.FixedColumnWidth(80),
              5: pw.FlexColumnWidth(3),
            },
            rowDecoration: pw.BoxDecoration(
              border: pw.Border(
                bottom: pw.BorderSide(color: PdfColors.grey300, width: 0.4),
              ),
            ),
          ),
        ],
      ),
    );

    await Printing.layoutPdf(onLayout: (_) async => pdf.save());
  }

  static pw.Widget _buildHeader(
    String wardName,
    String dateStr,
    Map<String, int> summary,
  ) {
    return pw.Padding(
      padding: const pw.EdgeInsets.only(bottom: 12),
      child: pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.start,
        children: [
          pw.Row(
            crossAxisAlignment: pw.CrossAxisAlignment.start,
            mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
            children: [
              pw.Column(
                crossAxisAlignment: pw.CrossAxisAlignment.start,
                children: [
                  pw.Text(
                    wardName.isEmpty ? 'Bed Occupancy' : wardName,
                    style: pw.TextStyle(
                      fontSize: 18,
                      fontWeight: pw.FontWeight.bold,
                    ),
                  ),
                  pw.SizedBox(height: 2),
                  pw.Text(
                    'Bed Occupancy · $dateStr',
                    style: const pw.TextStyle(
                      fontSize: 10,
                      color: PdfColors.grey700,
                    ),
                  ),
                ],
              ),
              pw.Row(
                children: [
                  _summaryPill('Total', summary['total']!, PdfColors.grey700),
                  pw.SizedBox(width: 6),
                  _summaryPill(
                    'Available',
                    summary['available']!,
                    PdfColors.green700,
                  ),
                  pw.SizedBox(width: 6),
                  _summaryPill(
                    'Occupied',
                    summary['occupied']!,
                    PdfColors.red700,
                  ),
                  pw.SizedBox(width: 6),
                  _summaryPill(
                    'Maintenance',
                    summary['maintenance']!,
                    PdfColors.orange700,
                  ),
                ],
              ),
            ],
          ),
          pw.SizedBox(height: 8),
          pw.Container(height: 0.5, color: PdfColors.grey400),
        ],
      ),
    );
  }

  static pw.Widget _summaryPill(String label, int value, PdfColor color) {
    // 12%-alpha background tint of the accent color. PdfColor doesn't
    // expose a nice withAlpha helper; build it from the 0xRRGGBB bits.
    final tint = PdfColor(color.red, color.green, color.blue, 0.12);
    return pw.Container(
      padding: const pw.EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: pw.BoxDecoration(
        color: tint,
        borderRadius: pw.BorderRadius.circular(8),
        border: pw.Border.all(color: color, width: 0.4),
      ),
      child: pw.Row(
        mainAxisSize: pw.MainAxisSize.min,
        children: [
          pw.Text(
            label,
            style: pw.TextStyle(
              fontSize: 8,
              color: color,
              fontWeight: pw.FontWeight.bold,
            ),
          ),
          pw.SizedBox(width: 4),
          pw.Text(
            '$value',
            style: pw.TextStyle(
              fontSize: 10,
              color: color,
              fontWeight: pw.FontWeight.bold,
            ),
          ),
        ],
      ),
    );
  }

  static pw.Widget _buildFooter(pw.Context ctx) {
    return pw.Padding(
      padding: const pw.EdgeInsets.only(top: 12),
      child: pw.Row(
        mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
        children: [
          pw.Text(
            'Generated by VHHealth Staff app',
            style: const pw.TextStyle(fontSize: 8, color: PdfColors.grey600),
          ),
          pw.Text(
            'Page ${ctx.pageNumber} / ${ctx.pagesCount}',
            style: const pw.TextStyle(fontSize: 8, color: PdfColors.grey600),
          ),
        ],
      ),
    );
  }

  static Map<String, int> _summarise(List<Map<String, dynamic>> beds) {
    int available = 0, occupied = 0, maintenance = 0;
    for (final b in beds) {
      switch ((b['status'] ?? '').toString().toLowerCase()) {
        case 'available':
          available++;
          break;
        case 'occupied':
          occupied++;
          break;
        case 'maintenance':
          maintenance++;
          break;
      }
    }
    return {
      'total': beds.length,
      'available': available,
      'occupied': occupied,
      'maintenance': maintenance,
    };
  }

  static String _capitalize(String s) {
    if (s.isEmpty) return s;
    return s[0].toUpperCase() + s.substring(1).toLowerCase();
  }

  static String _truncate(String s, int max) {
    if (s.length <= max) return s;
    return '${s.substring(0, max)}…';
  }

  static String _shortDate(String iso) {
    try {
      final d = DateTime.parse(iso);
      return DateFormat('d MMM HH:mm').format(d);
    } catch (_) {
      return iso.length > 16 ? iso.substring(0, 16) : iso;
    }
  }
}
