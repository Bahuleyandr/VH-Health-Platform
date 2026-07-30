import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/features/clinical_continuity/widgets/continuity_pack_view.dart';

void main() {
  testWidgets('read-only and UNKNOWN warnings expose explicit semantics', (
    tester,
  ) async {
    final set = _set();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ContinuityPackView(set: set, pack: set.packs.single),
        ),
      ),
    );

    final banner = find.byWidgetPredicate(
      (widget) =>
          widget is Semantics &&
          widget.properties.label == 'READ ONLY — CONTINUITY PACK' &&
          widget.properties.header == true,
    );
    final unknown = find.byWidgetPredicate(
      (widget) =>
          widget is Semantics &&
          widget.properties.label == 'Allergy status UNKNOWN — not recorded' &&
          widget.properties.liveRegion == true,
    );
    expect(banner, findsOneWidget);
    expect(unknown, findsWidgets);
  });

  testWidgets('200 percent text scale remains scrollable without overflow', (
    tester,
  ) async {
    final set = _set();
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: SizedBox(
            width: 320,
            height: 480,
            child: ContinuityPackView(set: set, pack: set.packs.single),
          ),
        ),
      ),
    );
    await tester.drag(
      find.byKey(const Key('continuity-pack-list')),
      const Offset(0, -300),
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('continuity-pack-list')), findsOneWidget);
  });

  test('frozen warning colors meet WCAG AA contrast for normal text', () {
    const banner = Color(0xff7f1d1d);
    const warningText = Color(0xff431407);
    const warningSurface = Color(0xffffe0b2);

    expect(_contrast(banner, Colors.white), greaterThanOrEqualTo(4.5));
    expect(_contrast(warningText, warningSurface), greaterThanOrEqualTo(4.5));
  });
}

double _contrast(Color first, Color second) {
  final lighter = first.computeLuminance() > second.computeLuminance()
      ? first.computeLuminance()
      : second.computeLuminance();
  final darker = first.computeLuminance() > second.computeLuminance()
      ? second.computeLuminance()
      : first.computeLuminance();
  return (lighter + 0.05) / (darker + 0.05);
}

VerifiedClinicalContinuitySet _set() {
  final generatedAt = DateTime.parse('2026-07-30T00:30:00.000Z');
  final pack = ClinicalContinuityPack(
    locationType: 'ward',
    locationId: 'ward-10',
    locationLabel: 'Ward 10',
    content: {
      'patients': List<Object?>.generate(
        4,
        (index) => {
          'identity': {
            'state': 'known',
            'value': {
              'name': {
                'state': 'known',
                'value': 'Patient ${index + 1}',
                'recorded_at': '2026-07-30T00:00:00.000Z',
              },
            },
            'recorded_at': '2026-07-30T00:00:00.000Z',
          },
          'allergies': {'state': 'unknown', 'value': null, 'recorded_at': null},
        },
      ),
    },
    htmlBytes: Uint8List(0),
    generatedAt: generatedAt,
    expiresAt: DateTime.parse('2026-07-30T04:00:00.000Z'),
    freshness: ClinicalContinuityFreshness.current,
  );
  return VerifiedClinicalContinuitySet(
    audience: const ClinicalContinuityAudience(
      tenantId: '52e31913-c846-4458-a21b-31cd2f457e9b',
      facilityId: '41',
    ),
    facilityName: 'VH Central',
    facilityTimezone: 'Asia/Kolkata',
    policyId: '55555555-5555-4555-8555-555555555555',
    publicationSetId: '66666666-6666-4666-8666-666666666666',
    localUnlockPolicy: const ClinicalContinuityLocalUnlockPolicy(
      authenticationMode: 'mtls_client_certificate',
      maximumAuthorizationMinutes: 720,
      emergencyReadPosture: 'disabled',
    ),
    localGrants: [
      ClinicalContinuityLocalGrant(
        staffId: '22222222-2222-4222-8222-222222222222',
        deviceId: 'staff-device-1',
        locationType: 'ward',
        locationId: 'ward-10',
        validFrom: generatedAt,
        validUntil: pack.expiresAt,
      ),
    ],
    prefetchSession: ClinicalContinuitySessionContext(
      tenantId: '52e31913-c846-4458-a21b-31cd2f457e9b',
      facilityId: '41',
      staffId: '22222222-2222-4222-8222-222222222222',
      role: 'nurse',
      deviceId: 'staff-device-1',
      authenticatedAt: generatedAt,
    ),
    provenance: const ClinicalContinuitySourceProvenance(
      sourceRevision: 'source-17',
      sourceWatermark: '{"revision":"source-17"}',
      accessRevision: '11',
    ),
    signingKeyFingerprints: const {
      'continuity-pack-current-k1':
          '0000000000000000000000000000000000000000000000000000000000000000',
    },
    floors: ClinicalContinuityFloors(
      policyVersion: '7',
      manifestVersion: '9',
      revocationEpoch: '3',
      trustedNow: generatedAt,
    ),
    generatedAt: generatedAt,
    expiresAt: pack.expiresAt,
    evaluatedAt: generatedAt,
    packs: [pack],
    verifiedByteLength: 4096,
  );
}
