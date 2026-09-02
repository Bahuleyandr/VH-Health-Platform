import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/services/bed_board_print_service.dart';
import 'package:vhhealth_staff/core/services/bed_board_shaped_text.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(_loadPackagedBedBoardFonts);

  const nativeContent = <String, ({String ward, String patient, String notes})>{
    'en': (
      ward: 'General Ward',
      patient: 'Asha Rao',
      notes: 'Observation continues',
    ),
    'hi': (
      ward: 'सामान्य वार्ड',
      patient: 'आशा शर्मा',
      notes: 'निगरानी जारी है',
    ),
    'ta': (
      ward: 'பொது வார்டு',
      patient: 'மீனா குமார்',
      notes: 'கண்காணிப்பு தொடர்கிறது',
    ),
    'te': (
      ward: 'సాధారణ వార్డు',
      patient: 'ఆశ కుమారి',
      notes: 'పర్యవేక్షణ కొనసాగుతోంది',
    ),
    'ml': (
      ward: 'പൊതു വാർഡ്',
      patient: 'ആശ നായർ',
      notes: 'നിരീക്ഷണം തുടരുന്നു',
    ),
  };

  for (final entry in nativeContent.entries) {
    testWidgets('${entry.key} bed-board headers fit without ellipsis', (
      tester,
    ) async {
      expect(
        BedBoardPrintService.debugOverflowingHeaderLabels(
          AppStrings.forLocale(Locale(entry.key)),
        ),
        isEmpty,
      );
    });

    testWidgets(
      'saves ${entry.key} bed-board PDF as Flutter-shaped page raster',
      (tester) async {
        final bytes = (await tester.runAsync(
          () => BedBoardPrintService.buildPdf(
            wardName: entry.value.ward,
            beds: [
              {
                'bed_number': 'A-101',
                'status': 'occupied',
                'patient_full_name': entry.value.patient,
                'patient_age': 42,
                'admission_admitted_at': '2026-09-02T08:15:00Z',
                'notes': entry.value.notes,
              },
            ],
            strings: AppStrings.forLocale(Locale(entry.key)),
            generatedBy: entry.value.patient,
            generatedAt: DateTime.utc(2026, 9, 2, 10, 30),
          ),
        ))!;

        expect(utf8.decode(bytes.take(5).toList()), '%PDF-');
        expect(bytes.length, greaterThan(10000));
        final pdfSyntax = latin1.decode(bytes, allowInvalid: true);
        expect(pdfSyntax, contains('/Subtype/Image'));
        expect(pdfSyntax, isNot(contains('/FontFile')));

        final artifactDirectory =
            Platform.environment['VH_BED_BOARD_PDF_ARTIFACT_DIR'];
        if (artifactDirectory != null && artifactDirectory.isNotEmpty) {
          Directory(artifactDirectory).createSync(recursive: true);
          File('$artifactDirectory/bed-board-${entry.key}.pdf')
              .writeAsBytesSync(bytes, flush: true);
        }
      },
    );
  }

  const clusterSamples = <String, String>{
    'hi': 'क्ष',
    'ta': 'க்ஷ',
    'te': 'క్ష',
    'ml': 'ക്ഷ',
  };

  for (final entry in clusterSamples.entries) {
    testWidgets(
      '${entry.key} conjunct exposes engine-shaped cluster evidence with ink',
      (tester) async {
        final result = (await tester.runAsync(() async {
          final evidence = await BedBoardShapedText.renderEvidence(
            text: entry.value,
            languageCode: entry.key,
          );
          return (
            evidence: evidence,
            ink: await _nonTransparentPixelCount(evidence.pngBytes),
          );
        }))!;
        final evidence = result.evidence;

        expect(result.ink, greaterThan(40));

        expect(evidence.clusters, isNotEmpty);
        expect(evidence.clusters.first.start, 0);
        expect(evidence.clusters.last.end, entry.value.length);
        expect(
          evidence.clusters.any((cluster) => cluster.end - cluster.start > 1),
          isTrue,
        );
        expect(
          evidence.clusters.every((cluster) => cluster.bounds.width > 0),
          isTrue,
        );
      },
    );
  }

  testWidgets(
    'fonts and all upstream notices are in the Flutter asset bundle',
    (tester) async {
      const fontAssets = <String>[
        'assets/fonts/noto/NotoSansDevanagari-Regular.ttf',
        'assets/fonts/noto/NotoSansDevanagari-Bold.ttf',
        'assets/fonts/noto/NotoSansTamil-Regular.ttf',
        'assets/fonts/noto/NotoSansTamil-Bold.ttf',
        'assets/fonts/noto/NotoSansTelugu-Regular.ttf',
        'assets/fonts/noto/NotoSansTelugu-Bold.ttf',
        'assets/fonts/noto/NotoSansMalayalam-Regular.ttf',
        'assets/fonts/noto/NotoSansMalayalam-Bold.ttf',
      ];
      const families = <String>[
        'NotoSansDevanagari',
        'NotoSansTamil',
        'NotoSansTelugu',
        'NotoSansMalayalam',
      ];
      final noticeAssets = <String>[
        for (final family in families)
          for (final notice in const ['OFL', 'AUTHORS', 'CONTRIBUTORS'])
            'assets/fonts/noto/licenses/$family-$notice.txt',
      ];
      final manifest = await AssetManifest.loadFromAssetBundle(rootBundle);
      final packaged = manifest.listAssets();

      for (final path in [...fontAssets, ...noticeAssets]) {
        expect(packaged, contains(path), reason: '$path missing from bundle');
        final bytes = await rootBundle.load(path);
        expect(bytes.lengthInBytes, greaterThan(0), reason: '$path is empty');
      }
      for (final path in noticeAssets.where(
        (path) => path.endsWith('OFL.txt'),
      )) {
        final notice = await rootBundle.loadString(path);
        expect(notice, contains('SIL OPEN FONT LICENSE Version 1.1'));
        expect(notice, contains('Copyright'));
      }

      final source = File('lib/core/services/bed_board_print_service.dart')
          .readAsStringSync();
      final pubspec = File('pubspec.yaml').readAsStringSync();
      final provenance = File('assets/fonts/noto/PROVENANCE.md')
          .readAsStringSync();
      expect(source, contains('BedBoardShapedText.paint'));
      expect(source, isNot(contains('pw.Text(')));
      expect(source, isNot(contains('PdfGoogleFonts')));
      expect(pubspec, contains('- assets/fonts/noto/licenses/'));
      expect(pubspec, contains('family: VH Bed Board Malayalam'));
      expect(provenance, contains('SIL Open Font License 1.1'));
      expect(provenance, contains('never receives Indic code points'));
    },
  );
}

Future<void> _loadPackagedBedBoardFonts() async {
  const families = <String, List<String>>{
    'VH Bed Board Devanagari': [
      'assets/fonts/noto/NotoSansDevanagari-Regular.ttf',
      'assets/fonts/noto/NotoSansDevanagari-Bold.ttf',
    ],
    'VH Bed Board Tamil': [
      'assets/fonts/noto/NotoSansTamil-Regular.ttf',
      'assets/fonts/noto/NotoSansTamil-Bold.ttf',
    ],
    'VH Bed Board Telugu': [
      'assets/fonts/noto/NotoSansTelugu-Regular.ttf',
      'assets/fonts/noto/NotoSansTelugu-Bold.ttf',
    ],
    'VH Bed Board Malayalam': [
      'assets/fonts/noto/NotoSansMalayalam-Regular.ttf',
      'assets/fonts/noto/NotoSansMalayalam-Bold.ttf',
    ],
  };
  for (final entry in families.entries) {
    final loader = FontLoader(entry.key);
    for (final path in entry.value) {
      loader.addFont(rootBundle.load(path));
    }
    await loader.load();
  }
}

Future<int> _nonTransparentPixelCount(List<int> pngBytes) async {
  final codec = await ui.instantiateImageCodec(Uint8List.fromList(pngBytes));
  try {
    final frame = await codec.getNextFrame();
    try {
      final data = await frame.image.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      );
      if (data == null) return 0;
      final bytes = data.buffer.asUint8List();
      var count = 0;
      for (var index = 3; index < bytes.length; index += 4) {
        if (bytes[index] != 0) count++;
      }
      return count;
    } finally {
      frame.image.dispose();
    }
  } finally {
    codec.dispose();
  }
}
