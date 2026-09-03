import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import '../../l10n/app_strings.dart';
import 'bed_board_shaped_text.dart';

/// Renders a printable A4 occupancy sheet for the current bed-board view.
///
/// All text is shaped and painted by Flutter's engine into deterministic A4
/// page rasters before those images are embedded in the PDF. dart_pdf only
/// wraps the finished page images; it never receives Indic text.
class BedBoardPrintService {
  BedBoardPrintService._();

  static const _rasterScale = 2.0;
  static const _margin = 28.0;
  static const _tableTop = 118.0;
  static const _tableHeaderHeight = 36.0;
  static const _tableHeaderFontSize = 7.2;
  static const _tableHeaderMaxLines = 2;
  static const _rowHeight = 31.0;
  static const _rowsPerPage = 20;

  static const _ink = ui.Color(0xFF172033);
  static const _mutedInk = ui.Color(0xFF5B6578);
  static const _blue900 = ui.Color(0xFF173E70);
  static const _line = ui.Color(0xFFD4D9E2);
  static const _alternateRow = ui.Color(0xFFF5F7FA);
  static const _white = ui.Color(0xFFFFFFFF);

  static Future<void> print({
    required String wardName,
    required List<Map<String, dynamic>> beds,
    required AppStrings strings,
    required String generatedBy,
  }) async {
    final bytes = await buildPdf(
      wardName: wardName,
      beds: beds,
      strings: strings,
      generatedBy: generatedBy,
    );

    await Printing.layoutPdf(onLayout: (_) async => bytes);
  }

  static Future<Uint8List> buildPdf({
    required String wardName,
    required List<Map<String, dynamic>> beds,
    required AppStrings strings,
    required String generatedBy,
    DateTime? generatedAt,
  }) async {
    final sorted = [...beds]
      ..sort((a, b) {
        final an = (a['bed_number'] ?? a['bedNumber'] ?? '').toString();
        final bn = (b['bed_number'] ?? b['bedNumber'] ?? '').toString();
        return an.compareTo(bn);
      });
    final chunks = <List<Map<String, dynamic>>>[];
    if (sorted.isEmpty) {
      chunks.add(const []);
    } else {
      for (var start = 0; start < sorted.length; start += _rowsPerPage) {
        final end = (start + _rowsPerPage).clamp(0, sorted.length).toInt();
        chunks.add(sorted.sublist(start, end));
      }
    }

    final pdf = pw.Document();
    final pageCount = chunks.length;
    final created = generatedAt ?? DateTime.now();
    for (var index = 0; index < chunks.length; index++) {
      final pageRaster = await _renderPage(
        wardName: wardName,
        allBeds: sorted,
        pageBeds: chunks[index],
        strings: strings,
        generatedBy: generatedBy,
        generatedAt: created,
        pageNumber: index + 1,
        pageCount: pageCount,
      );
      final image = pw.MemoryImage(pageRaster);
      pdf.addPage(
        pw.Page(
          pageFormat: PdfPageFormat.a4,
          margin: pw.EdgeInsets.zero,
          build: (_) => pw.Image(
            image,
            width: PdfPageFormat.a4.width,
            height: PdfPageFormat.a4.height,
            fit: pw.BoxFit.fill,
          ),
        ),
      );
    }
    return pdf.save();
  }

  static Future<Uint8List> _renderPage({
    required String wardName,
    required List<Map<String, dynamic>> allBeds,
    required List<Map<String, dynamic>> pageBeds,
    required AppStrings strings,
    required String generatedBy,
    required DateTime generatedAt,
    required int pageNumber,
    required int pageCount,
  }) async {
    final width = PdfPageFormat.a4.width;
    final height = PdfPageFormat.a4.height;
    final languageCode = strings.locale.languageCode;
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder)..scale(_rasterScale, _rasterScale);
    canvas.drawRect(
      ui.Rect.fromLTWH(0, 0, width, height),
      ui.Paint()..color = _white,
    );

    final title = wardName.isEmpty ? strings.bedBoardPrintOccupancy : wardName;
    _text(
      canvas,
      title,
      languageCode,
      ui.Rect.fromLTWH(_margin, 24, width - (_margin * 2), 28),
      18,
      bold: true,
    );
    final date = DateFormat('yyyy-MM-dd HH:mm').format(generatedAt.toLocal());
    _text(
      canvas,
      strings.bedBoardPrintOccupancyDate(date),
      languageCode,
      ui.Rect.fromLTWH(_margin, 51, width - (_margin * 2), 18),
      9,
      color: _mutedInk,
    );

    final summary = _summarise(allBeds);
    final pillWidth = (width - (_margin * 2)) / 4;
    final pills = <(String, int, ui.Color)>[
      (strings.bedBoardWardStatTotal, summary['total']!, _mutedInk),
      (
        strings.bedBoardLegendAvailable,
        summary['available']!,
        const ui.Color(0xFF157347),
      ),
      (
        strings.bedBoardLegendOccupied,
        summary['occupied']!,
        const ui.Color(0xFFB42318),
      ),
      (
        strings.bedBoardLegendMaintenance,
        summary['maintenance']!,
        const ui.Color(0xFFB54708),
      ),
    ];
    for (var index = 0; index < pills.length; index++) {
      _summaryPill(
        canvas,
        languageCode,
        ui.Rect.fromLTWH(_margin + (index * pillWidth), 76, pillWidth - 5, 27),
        pills[index].$1,
        pills[index].$2,
        pills[index].$3,
      );
    }

    canvas.drawLine(
      const ui.Offset(_margin, 110),
      ui.Offset(width - _margin, 110),
      ui.Paint()
        ..color = _line
        ..strokeWidth = 0.7,
    );

    final availableWidth = width - (_margin * 2);
    final columns = _columnWidths(availableWidth);
    final headers = _headerLabels(strings);
    canvas.drawRect(
      ui.Rect.fromLTWH(_margin, _tableTop, availableWidth, _tableHeaderHeight),
      ui.Paint()..color = _blue900,
    );
    _drawCells(
      canvas,
      languageCode,
      headers,
      columns,
      _tableTop,
      _tableHeaderHeight,
      fontSize: _tableHeaderFontSize,
      bold: true,
      color: _white,
      maxLines: _tableHeaderMaxLines,
    );

    for (var rowIndex = 0; rowIndex < pageBeds.length; rowIndex++) {
      final bed = pageBeds[rowIndex];
      final top = _tableTop + _tableHeaderHeight + (rowIndex * _rowHeight);
      if (rowIndex.isOdd) {
        canvas.drawRect(
          ui.Rect.fromLTWH(_margin, top, availableWidth, _rowHeight),
          ui.Paint()..color = _alternateRow,
        );
      }
      final bedNum = (bed['bed_number'] ?? bed['bedNumber'] ?? '—').toString();
      final status = (bed['status'] ?? '').toString();
      final patient =
          (bed['patient_full_name'] ??
                  bed['patient_name'] ??
                  bed['patientName'] ??
                  '')
              .toString();
      final age = bed['patient_age'];
      final admitted = bed['admission_admitted_at'] ?? bed['admitted_at'];
      final notes = (bed['notes'] ?? '').toString();
      _drawCells(
        canvas,
        languageCode,
        [
          bedNum,
          _statusLabel(strings, status),
          patient.isEmpty ? '—' : patient,
          (age == null || age.toString().isEmpty) ? '—' : age.toString(),
          admitted == null ? '—' : _shortDate(admitted.toString()),
          notes.isEmpty ? '—' : notes,
        ],
        columns,
        top,
        _rowHeight,
        fontSize: 8,
        maxLines: 2,
      );
      canvas.drawLine(
        ui.Offset(_margin, top + _rowHeight),
        ui.Offset(width - _margin, top + _rowHeight),
        ui.Paint()
          ..color = _line
          ..strokeWidth = 0.4,
      );
    }

    final footerTop = height - 36;
    canvas.drawLine(
      ui.Offset(_margin, footerTop - 6),
      ui.Offset(width - _margin, footerTop - 6),
      ui.Paint()
        ..color = _line
        ..strokeWidth = 0.5,
    );
    _text(
      canvas,
      generatedBy,
      languageCode,
      ui.Rect.fromLTWH(_margin, footerTop, availableWidth * 0.62, 16),
      7.5,
      color: _mutedInk,
    );
    _text(
      canvas,
      strings.bedBoardPrintPage(pageNumber, pageCount),
      languageCode,
      ui.Rect.fromLTWH(
        _margin + (availableWidth * 0.62),
        footerTop,
        availableWidth * 0.38,
        16,
      ),
      7.5,
      color: _mutedInk,
      textAlign: ui.TextAlign.right,
    );

    final picture = recorder.endRecording();
    final image = await picture.toImage(
      (width * _rasterScale).round(),
      (height * _rasterScale).round(),
    );
    picture.dispose();
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) {
        throw StateError('Flutter engine did not encode the bed-board page');
      }
      return data.buffer.asUint8List();
    } finally {
      image.dispose();
    }
  }

  static void _drawCells(
    ui.Canvas canvas,
    String languageCode,
    List<String> values,
    List<double> widths,
    double top,
    double height, {
    required double fontSize,
    bool bold = false,
    ui.Color color = _ink,
    int maxLines = 1,
  }) {
    var left = _margin;
    for (var index = 0; index < values.length; index++) {
      _text(
        canvas,
        values[index],
        languageCode,
        ui.Rect.fromLTWH(left + 5, top + 2, widths[index] - 10, height - 4),
        fontSize,
        bold: bold,
        color: color,
        maxLines: maxLines,
        textAlign: index == 3 ? ui.TextAlign.right : ui.TextAlign.left,
      );
      left += widths[index];
    }
  }

  static List<double> _columnWidths(double availableWidth) {
    final widths = <double>[56, 72, 112, 42, 100];
    widths.add(availableWidth - widths.fold<double>(0, (a, b) => a + b));
    return widths;
  }

  static List<String> _headerLabels(AppStrings strings) => [
    strings.bedBoardPrintColumnBed,
    strings.bedBoardPrintColumnStatus,
    strings.bedBoardPrintColumnPatient,
    strings.bedBoardPrintColumnAge,
    strings.bedBoardPrintColumnAdmitted,
    strings.bedBoardPrintColumnNotes,
  ];

  @visibleForTesting
  static List<String> debugOverflowingHeaderLabels(AppStrings strings) {
    final availableWidth = PdfPageFormat.a4.width - (_margin * 2);
    final widths = _columnWidths(availableWidth);
    final labels = _headerLabels(strings);
    final languageCode = strings.locale.languageCode;
    final overflowing = <String>[];
    for (var index = 0; index < labels.length; index++) {
      final paragraph = BedBoardShapedText.layout(
        text: labels[index],
        languageCode: languageCode,
        width: widths[index] - 10,
        fontSize: _tableHeaderFontSize,
        color: _white,
        bold: true,
        maxLines: _tableHeaderMaxLines,
        textAlign: index == 3 ? ui.TextAlign.right : ui.TextAlign.left,
      );
      final overflows =
          paragraph.didExceedMaxLines ||
          paragraph.height > _tableHeaderHeight - 4;
      paragraph.dispose();
      if (overflows) {
        overflowing.add(labels[index]);
      }
    }
    return overflowing;
  }

  static void _summaryPill(
    ui.Canvas canvas,
    String languageCode,
    ui.Rect bounds,
    String label,
    int value,
    ui.Color color,
  ) {
    final background = ui.Color.fromARGB(
      28,
      (color.r * 255).round(),
      (color.g * 255).round(),
      (color.b * 255).round(),
    );
    canvas.drawRRect(
      ui.RRect.fromRectAndRadius(bounds, const ui.Radius.circular(8)),
      ui.Paint()..color = background,
    );
    canvas.drawRRect(
      ui.RRect.fromRectAndRadius(bounds, const ui.Radius.circular(8)),
      ui.Paint()
        ..color = color
        ..style = ui.PaintingStyle.stroke
        ..strokeWidth = 0.5,
    );
    _text(
      canvas,
      label,
      languageCode,
      ui.Rect.fromLTWH(
        bounds.left + 7,
        bounds.top + 2,
        bounds.width - 31,
        bounds.height - 4,
      ),
      7.2,
      bold: true,
      color: color,
    );
    _text(
      canvas,
      '$value',
      languageCode,
      ui.Rect.fromLTWH(
        bounds.right - 25,
        bounds.top + 2,
        18,
        bounds.height - 4,
      ),
      9,
      bold: true,
      color: color,
      textAlign: ui.TextAlign.right,
    );
  }

  static void _text(
    ui.Canvas canvas,
    String text,
    String languageCode,
    ui.Rect bounds,
    double fontSize, {
    bool bold = false,
    ui.Color color = _ink,
    int maxLines = 1,
    ui.TextAlign textAlign = ui.TextAlign.left,
  }) {
    canvas.save();
    canvas.clipRect(bounds);
    BedBoardShapedText.paint(
      canvas,
      text: text,
      languageCode: languageCode,
      bounds: bounds,
      fontSize: fontSize,
      color: color,
      bold: bold,
      maxLines: maxLines,
      textAlign: textAlign,
    );
    canvas.restore();
  }

  static Map<String, int> _summarise(List<Map<String, dynamic>> beds) {
    int available = 0, occupied = 0, maintenance = 0;
    for (final bed in beds) {
      switch ((bed['status'] ?? '').toString().toLowerCase()) {
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

  static String _statusLabel(AppStrings strings, String status) {
    return switch (status.trim().toLowerCase()) {
      'available' => strings.bedBoardLegendAvailable,
      'occupied' => strings.bedBoardLegendOccupied,
      'maintenance' => strings.bedBoardLegendMaintenance,
      'cleaning' => strings.bedBoardFilterCleaning,
      _ => status,
    };
  }

  static String _shortDate(String iso) {
    try {
      final date = DateTime.parse(iso);
      return DateFormat('yyyy-MM-dd HH:mm').format(date.toLocal());
    } catch (_) {
      return iso.length > 16 ? iso.substring(0, 16) : iso;
    }
  }
}
