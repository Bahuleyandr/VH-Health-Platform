import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/features/clinical_continuity/services/continuity_print_service.dart';

const _validityLine =
    'Generated 30 Jul 2026 05:30 IST — NOT VALID AFTER '
    '30 Jul 2026 09:30 IST, then use paper and phone.';

void main() {
  test(
    'converts the exact verified HTML bytes and submits the resulting PDF',
    () async {
      String? convertedHtml;
      Uint8List? submittedPdf;
      final service = ContinuityPrintService(
        convertHtml: (html) async {
          convertedHtml = html;
          return Uint8List.fromList([1, 2, 3]);
        },
        layoutPdf: (pdf) async => submittedPdf = pdf,
      );
      final html = '<!doctype html><p>$_validityLine</p><p>Signed pack</p>';

      await service.printVerifiedPack(_pack(html: html));

      expect(convertedHtml, html);
      expect(submittedPdf, orderedEquals([1, 2, 3]));
    },
  );

  test('refuses expired or clock-uncertain packs before conversion', () async {
    var conversions = 0;
    final service = ContinuityPrintService(
      convertHtml: (_) async {
        conversions += 1;
        return Uint8List(0);
      },
      layoutPdf: (_) async {},
    );

    await expectLater(
      service.printVerifiedPack(
        _pack(
          html: '<p>$_validityLine</p>',
          freshness: ClinicalContinuityFreshness.expired,
        ),
      ),
      throwsStateError,
    );
    await expectLater(
      service.printVerifiedPack(
        _pack(
          html: '<p>$_validityLine</p>',
          freshness: ClinicalContinuityFreshness.clockUncertain,
        ),
      ),
      throwsStateError,
    );
    expect(conversions, 0);
  });

  test(
    'refuses HTML without the complete validity and fallback line',
    () async {
      final service = ContinuityPrintService(
        convertHtml: (_) async => Uint8List(0),
        layoutPdf: (_) async {},
      );

      await expectLater(
        service.printVerifiedPack(
          _pack(html: '<p>Generated today — NOT VALID AFTER later</p>'),
        ),
        throwsStateError,
      );
    },
  );

  test('requires the OPD destroy-after-clinic-day instruction', () async {
    var conversions = 0;
    final service = ContinuityPrintService(
      convertHtml: (_) async {
        conversions += 1;
        return Uint8List(0);
      },
      layoutPdf: (_) async {},
    );

    await expectLater(
      service.printVerifiedPack(
        _pack(html: '<p>$_validityLine</p>', locationType: 'opd_day'),
      ),
      throwsStateError,
    );
    await service.printVerifiedPack(
      _pack(
        html: '<p>$_validityLine</p><p>Destroy after clinic day</p>',
        locationType: 'opd_day',
      ),
    );

    expect(conversions, 1);
  });

  test('refuses malformed UTF-8 before conversion', () async {
    var conversions = 0;
    final service = ContinuityPrintService(
      convertHtml: (_) async {
        conversions += 1;
        return Uint8List(0);
      },
      layoutPdf: (_) async {},
    );
    final pack = _pack(html: '<p>$_validityLine</p>');
    final malformed = ClinicalContinuityPack(
      locationType: pack.locationType,
      locationId: pack.locationId,
      locationLabel: pack.locationLabel,
      content: pack.content,
      htmlBytes: Uint8List.fromList([0xc3, 0x28]),
      generatedAt: pack.generatedAt,
      expiresAt: pack.expiresAt,
      freshness: pack.freshness,
    );

    await expectLater(
      service.printVerifiedPack(malformed),
      throwsFormatException,
    );
    expect(conversions, 0);
  });
}

ClinicalContinuityPack _pack({
  required String html,
  String locationType = 'ward',
  ClinicalContinuityFreshness freshness = ClinicalContinuityFreshness.current,
}) {
  return ClinicalContinuityPack(
    locationType: locationType,
    locationId: locationType == 'opd_day' ? 'opd-2026-07-30' : 'ward-10',
    locationLabel: locationType == 'opd_day' ? 'OPD 30 Jul' : 'Ward 10',
    content: const {'patients': <Object?>[]},
    htmlBytes: Uint8List.fromList(utf8.encode(html)),
    generatedAt: DateTime.parse('2026-07-30T00:00:00.000Z'),
    expiresAt: DateTime.parse('2026-07-30T04:00:00.000Z'),
    freshness: freshness,
  );
}
