import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

class BedBoardGlyphCluster {
  const BedBoardGlyphCluster({
    required this.start,
    required this.end,
    required this.bounds,
  });

  final int start;
  final int end;
  final ui.Rect bounds;
}

class BedBoardShapingEvidence {
  const BedBoardShapingEvidence({
    required this.pngBytes,
    required this.clusters,
    required this.pixelWidth,
    required this.pixelHeight,
  });

  final Uint8List pngBytes;
  final List<BedBoardGlyphCluster> clusters;
  final int pixelWidth;
  final int pixelHeight;
}

enum BedBoardTextVerticalAlign { top, center, bottom }

/// Builds text through Flutter's engine paragraph stack. That stack performs
/// Unicode script itemisation, font fallback and OpenType shaping before the
/// paragraph is painted. Bed-board PDFs embed the resulting page raster and
/// never hand Indic code points to dart_pdf's unshaped text writer.
class BedBoardShapedText {
  BedBoardShapedText._();

  static const _familyByLanguage = <String, String>{
    'en': 'VH Bed Board Devanagari',
    'hi': 'VH Bed Board Devanagari',
    'ta': 'VH Bed Board Tamil',
    'te': 'VH Bed Board Telugu',
    'ml': 'VH Bed Board Malayalam',
  };

  static const _fallbackFamilies = <String>[
    'VH Bed Board Devanagari',
    'VH Bed Board Tamil',
    'VH Bed Board Telugu',
    'VH Bed Board Malayalam',
  ];

  static ui.Paragraph layout({
    required String text,
    required String languageCode,
    required double width,
    required double fontSize,
    required ui.Color color,
    bool bold = false,
    int maxLines = 1,
    ui.TextAlign textAlign = ui.TextAlign.left,
  }) {
    final family = _familyByLanguage[languageCode] ?? _familyByLanguage['en']!;
    final locale = ui.Locale(languageCode);
    final builder =
        ui.ParagraphBuilder(
          ui.ParagraphStyle(
            textDirection: ui.TextDirection.ltr,
            textAlign: textAlign,
            maxLines: maxLines,
            ellipsis: '…',
            fontFamily: family,
            fontSize: fontSize,
            height: 1.15,
            fontWeight: bold ? ui.FontWeight.w700 : ui.FontWeight.w400,
            locale: locale,
          ),
        )..pushStyle(
          ui.TextStyle(
            color: color,
            fontFamily: family,
            fontFamilyFallback: _fallbackFamilies,
            fontSize: fontSize,
            height: 1.15,
            fontWeight: bold ? ui.FontWeight.w700 : ui.FontWeight.w400,
            locale: locale,
          ),
        );
    builder.addText(text);
    return builder.build()..layout(ui.ParagraphConstraints(width: width));
  }

  static void paint(
    ui.Canvas canvas, {
    required String text,
    required String languageCode,
    required ui.Rect bounds,
    required double fontSize,
    required ui.Color color,
    bool bold = false,
    int maxLines = 1,
    ui.TextAlign textAlign = ui.TextAlign.left,
    BedBoardTextVerticalAlign textAlignVertical =
        BedBoardTextVerticalAlign.center,
  }) {
    final paragraph = layout(
      text: text,
      languageCode: languageCode,
      width: bounds.width,
      fontSize: fontSize,
      color: color,
      bold: bold,
      maxLines: maxLines,
      textAlign: textAlign,
    );
    final top = switch (textAlignVertical) {
      BedBoardTextVerticalAlign.top => bounds.top,
      BedBoardTextVerticalAlign.bottom => bounds.bottom - paragraph.height,
      _ => bounds.top + math.max(0, (bounds.height - paragraph.height) / 2),
    };
    canvas.drawParagraph(paragraph, ui.Offset(bounds.left, top));
    // ui.Paragraph owns a native SkParagraph the Dart GC cannot see; a large
    // ward board builds well over a thousand of them per print.
    paragraph.dispose();
  }

  static Future<BedBoardShapingEvidence> renderEvidence({
    required String text,
    required String languageCode,
    double width = 240,
    double fontSize = 36,
  }) async {
    final paragraph = layout(
      text: text,
      languageCode: languageCode,
      width: width,
      fontSize: fontSize,
      color: const ui.Color(0xFF000000),
      maxLines: 2,
    );
    final pixelWidth = math.max(1, paragraph.longestLine.ceil() + 4);
    final pixelHeight = math.max(1, paragraph.height.ceil() + 4);
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    canvas.drawColor(const ui.Color(0x00000000), ui.BlendMode.src);
    canvas.drawParagraph(paragraph, const ui.Offset(2, 2));
    final image = await recorder.endRecording().toImage(
      pixelWidth,
      pixelHeight,
    );
    try {
      final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
      if (byteData == null) {
        throw StateError('Flutter engine did not encode the shaped text image');
      }
      return BedBoardShapingEvidence(
        pngBytes: byteData.buffer.asUint8List(),
        clusters: _clustersFor(text, paragraph),
        pixelWidth: pixelWidth,
        pixelHeight: pixelHeight,
      );
    } finally {
      image.dispose();
      paragraph.dispose();
    }
  }

  static List<BedBoardGlyphCluster> _clustersFor(
    String text,
    ui.Paragraph paragraph,
  ) {
    final result = <BedBoardGlyphCluster>[];
    final seen = <String>{};
    for (var offset = 0; offset < text.length; offset++) {
      final glyph = paragraph.getGlyphInfoAt(offset);
      if (glyph == null) continue;
      final range = glyph.graphemeClusterCodeUnitRange;
      final key = '${range.start}:${range.end}';
      if (!seen.add(key)) continue;
      result.add(
        BedBoardGlyphCluster(
          start: range.start,
          end: range.end,
          bounds: glyph.graphemeClusterLayoutBounds,
        ),
      );
    }
    return result;
  }
}
