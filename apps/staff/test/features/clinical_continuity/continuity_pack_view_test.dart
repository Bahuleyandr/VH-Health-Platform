import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/features/clinical_continuity/widgets/continuity_pack_view.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  testWidgets('renders verified metadata and exact UNKNOWN semantics', (
    tester,
  ) async {
    final set = _set();
    await tester.pumpWidget(
      _app(ContinuityPackView(set: set, pack: set.packs.single)),
    );

    expect(find.text('READ ONLY — CONTINUITY PACK'), findsOneWidget);
    expect(find.text('Facility: VH Central'), findsOneWidget);
    expect(find.text('Location: Ward 10'), findsOneWidget);
    expect(find.text('Status: AGED — verify field times'), findsOneWidget);
    expect(find.text('AGED — verify field times · age 2h'), findsOneWidget);
    expect(
      find.text(
        'Source revision / watermark: source-17 / '
        '{"revision":"source-17"}',
      ),
      findsOneWidget,
    );
    expect(find.text('Allergy status UNKNOWN — not recorded'), findsOneWidget);
    expect(
      find.text('Code status NOT RECORDED — confirm per hospital policy'),
      findsOneWidget,
    );
    expect(find.text('Contact precautions'), findsOneWidget);
    expect(find.textContaining('age 30m'), findsWidgets);
    expect(find.byType(TextButton), findsNothing);
    expect(find.byType(ElevatedButton), findsNothing);
  });

  testWidgets('renders all five locales without falling back to keys', (
    tester,
  ) async {
    final set = _set();
    for (final locale in AppStrings.supportedLocales) {
      await tester.pumpWidget(
        _app(
          ContinuityPackView(set: set, pack: set.packs.single),
          locale: locale,
        ),
      );
      await tester.pump();

      expect(find.text('continuity.read_only_banner'), findsNothing);
      expect(find.text('continuity.unknown.allergy'), findsNothing);
      expect(
        find.text(
          AppStrings.forLocale(locale).lookup('continuity.read_only_banner'),
        ),
        findsOneWidget,
      );
    }
  });

  test('facility-local time uses the signed IANA zone across DST', () {
    final before = formatClinicalContinuityFacilityTime(
      DateTime.parse('2026-03-08T06:30:00.000Z'),
      'America/New_York',
    );
    final after = formatClinicalContinuityFacilityTime(
      DateTime.parse('2026-03-08T07:30:00.000Z'),
      'America/New_York',
    );

    expect(before, '08 Mar 2026, 01:30 (EST)');
    expect(after, '08 Mar 2026, 03:30 (EDT)');
  });
}

Widget _app(Widget child, {Locale locale = const Locale('en')}) {
  return MaterialApp(
    locale: locale,
    supportedLocales: AppStrings.supportedLocales,
    localizationsDelegates: const [
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: Scaffold(body: child),
  );
}

VerifiedClinicalContinuitySet _set() {
  final generatedAt = DateTime.parse('2026-07-30T00:30:00.000Z');
  final pack = ClinicalContinuityPack(
    locationType: 'ward',
    locationId: 'ward-10',
    locationLabel: 'Ward 10',
    content: {
      'patients': [
        {
          'identity': {
            'state': 'known',
            'value': {
              'name': {
                'state': 'known',
                'value': 'Patient One',
                'recorded_at': '2026-07-30T00:00:00.000Z',
              },
              'mrn': {
                'state': 'known',
                'value': 'MRN-001',
                'recorded_at': '2026-07-30T00:00:00.000Z',
              },
            },
            'recorded_at': '2026-07-30T00:00:00.000Z',
          },
          'allergies': {'state': 'unknown', 'value': null, 'recorded_at': null},
          'code_status': {
            'state': 'unknown',
            'value': null,
            'recorded_at': null,
          },
          'isolation': {
            'state': 'known',
            'value': 'Contact precautions',
            'recorded_at': '2026-07-30T00:00:00.000Z',
          },
          'recently_administered_medications': {
            'state': 'known',
            'value': ['Paracetamol 500 mg at 05:15 IST'],
            'recorded_at': '2026-07-30T00:00:00.000Z',
          },
        },
      ],
    },
    htmlBytes: Uint8List(0),
    generatedAt: generatedAt,
    expiresAt: DateTime.parse('2026-07-30T04:00:00.000Z'),
    freshness: ClinicalContinuityFreshness.aged,
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
    evaluatedAt: DateTime.parse('2026-07-30T02:30:00.000Z'),
    packs: [pack],
    verifiedByteLength: 2048,
  );
}
