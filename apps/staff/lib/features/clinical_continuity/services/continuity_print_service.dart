import 'dart:convert';
import 'dart:typed_data';

import 'package:printing/printing.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

typedef ContinuityHtmlConverter = Future<Uint8List> Function(String html);
typedef ContinuityPdfLayout = Future<void> Function(Uint8List pdf);

class ContinuityPrintService {
  final ContinuityHtmlConverter _convertHtml;
  final ContinuityPdfLayout _layoutPdf;

  ContinuityPrintService({
    ContinuityHtmlConverter? convertHtml,
    ContinuityPdfLayout? layoutPdf,
  }) : _convertHtml =
           // Printing.convertHtml is the frozen C3.3 exact-HTML print path.
           // ignore: deprecated_member_use
           convertHtml ?? ((html) => Printing.convertHtml(html: html)),
       _layoutPdf =
           layoutPdf ??
           ((pdf) => Printing.layoutPdf(onLayout: (_) async => pdf));

  Future<void> printVerifiedPack(ClinicalContinuityPack pack) async {
    if (pack.freshness == ClinicalContinuityFreshness.expired ||
        pack.freshness == ClinicalContinuityFreshness.clockUncertain) {
      throw StateError('Verified continuity pack is not printable');
    }
    final html = utf8.decode(pack.htmlBytes, allowMalformed: false);
    if (!html.contains('Generated ') ||
        !html.contains(' — NOT VALID AFTER ') ||
        !html.contains(', then use paper and phone.')) {
      throw StateError('Continuity print validity line is missing');
    }
    if (pack.locationType == 'opd_day' &&
        !html.contains('Destroy after clinic day')) {
      throw StateError('OPD disposal instruction is missing');
    }
    final converted = await _convertHtml(html);
    await _layoutPdf(converted);
  }
}
