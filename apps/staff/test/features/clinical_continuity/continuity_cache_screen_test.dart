import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/clinical_continuity/screens/continuity_cache_screen.dart';
import 'package:vhhealth_staff/features/clinical_continuity/services/continuity_print_service.dart';
import 'package:vhhealth_staff/features/clinical_continuity/services/staff_continuity_repository.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('refusal shows paper-and-phone fallback and no PHI affordances', (
    tester,
  ) async {
    final repository = _ScreenRepository(
      const ClinicalContinuityAccessDecision.denied(
        ClinicalContinuityVerificationReasons.signatureInvalid,
      ),
    );

    await tester.pumpWidget(
      _app(ContinuityCacheScreen(repository: repository)),
    );
    await tester.pump();

    expect(
      find.text(
        'PACK VERIFICATION FAILED — this continuity pack cannot be displayed.',
      ),
      findsOneWidget,
    );
    expect(find.text('Use paper and phone.'), findsOneWidget);
    expect(find.text('Patient One'), findsNothing);
    expect(find.byTooltip('Print verified pack'), findsNothing);
    repository.dispose();
  });

  testWidgets('verified pack can print and refresh through explicit controls', (
    tester,
  ) async {
    final set = _set();
    final repository = _ScreenRepository(
      ClinicalContinuityAccessDecision.allowed(
        mode: ClinicalContinuityAccessMode.onlineAuthenticated,
        verifiedSet: set,
      ),
    );
    ClinicalContinuityPack? printed;
    final printService = ContinuityPrintService(
      convertHtml: (_) async {
        printed = set.packs.single;
        return Uint8List.fromList([1]);
      },
      layoutPdf: (_) async {},
    );

    await tester.pumpWidget(
      _app(
        ContinuityCacheScreen(
          repository: repository,
          printService: printService,
        ),
      ),
    );
    await tester.pump();

    expect(find.text('READ ONLY — CONTINUITY PACK'), findsOneWidget);
    expect(find.byTooltip('Print verified pack'), findsOneWidget);
    await tester.tap(find.byTooltip('Print verified pack'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(printed, same(set.packs.single));

    await tester.tap(find.byTooltip('Refresh continuity cache'));
    await tester.pump();
    await tester.pump();
    expect(repository.refreshCalls, 1);
    expect(repository.openCalls, 2);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(repository.clearCalls, 1);
    repository.dispose();
  });

  testWidgets('expired and locked reasons use specific refusal copy', (
    tester,
  ) async {
    final repository = _ScreenRepository(
      const ClinicalContinuityAccessDecision.denied(
        ClinicalContinuityVerificationReasons.packExpired,
      ),
    );
    await tester.pumpWidget(
      _app(ContinuityCacheScreen(repository: repository)),
    );
    await tester.pump();
    expect(
      find.text('PACK EXPIRED — this continuity pack cannot be displayed.'),
      findsOneWidget,
    );

    repository.decision = const ClinicalContinuityAccessDecision.denied(
      'LOCAL_AUTHORIZATION_EXPIRED',
    );
    await tester.tap(find.byTooltip('Refresh continuity cache'));
    await tester.pump();
    await tester.pump();
    expect(
      find.text(
        'LOCAL UNLOCK NOT AUTHORIZED — this continuity pack cannot be '
        'displayed.',
      ),
      findsOneWidget,
    );
    repository.dispose();
  });

  testWidgets('reauthorization clears prior PHI and print affordance', (
    tester,
  ) async {
    final set = _set();
    final repository = _ScreenRepository(
      ClinicalContinuityAccessDecision.allowed(
        mode: ClinicalContinuityAccessMode.onlineAuthenticated,
        verifiedSet: set,
      ),
    );
    await tester.pumpWidget(
      _app(ContinuityCacheScreen(repository: repository)),
    );
    await tester.pump();
    expect(find.text('Patient One'), findsOneWidget);
    expect(find.byTooltip('Print verified pack'), findsOneWidget);

    final pending = Completer<ClinicalContinuityAccessDecision>();
    repository.nextOpen = pending;
    await tester.tap(find.byTooltip('Refresh continuity cache'));
    await tester.pump();

    expect(find.text('Patient One'), findsNothing);
    expect(find.byTooltip('Print verified pack'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    pending.complete(
      const ClinicalContinuityAccessDecision.denied(
        ClinicalContinuityVerificationReasons.signatureInvalid,
      ),
    );
    await tester.pump();
    expect(
      find.text(
        'PACK VERIFICATION FAILED — this continuity pack cannot be displayed.',
      ),
      findsOneWidget,
    );
    repository.dispose();
  });
}

Widget _app(Widget child) {
  return ChangeNotifierProvider<ThemeProvider>(
    create: (_) => ThemeProvider(),
    child: MaterialApp(home: child),
  );
}

class _ScreenRepository extends StaffContinuityRepository {
  ClinicalContinuityAccessDecision decision;
  Completer<ClinicalContinuityAccessDecision>? nextOpen;
  int openCalls = 0;
  int refreshCalls = 0;
  int clearCalls = 0;

  _ScreenRepository(this.decision)
    : super(
        source: const _NoopSource(),
        cacheEnabled: true,
        localUnlockEnabled: true,
      );

  @override
  Future<ClinicalContinuityAccessDecision> openCached() async {
    openCalls += 1;
    final pending = nextOpen;
    if (pending != null) {
      nextOpen = null;
      return pending.future;
    }
    return decision;
  }

  @override
  Future<bool> requestRefresh() async {
    refreshCalls += 1;
    return true;
  }

  @override
  Future<void> clearDecryptedState() async {
    clearCalls += 1;
  }
}

class _NoopSource implements ClinicalContinuitySource {
  const _NoopSource();

  @override
  Future<ClinicalContinuityClockAssessment> assessClock() async =>
      const ClinicalContinuityClockAssessment(trusted: false, trustedNow: null);

  @override
  Future<void> cancel() async {}

  @override
  Future<ClinicalContinuitySessionContext?> currentSession() async => null;

  @override
  Future<ClinicalContinuitySourceSnapshot> fetchFacilitySet() =>
      throw StateError('unused');
}

VerifiedClinicalContinuitySet _set() {
  final generatedAt = DateTime.parse('2026-07-30T00:00:00.000Z');
  const validity =
      'Generated 30 Jul 2026 05:30 IST — NOT VALID AFTER '
      '30 Jul 2026 09:30 IST, then use paper and phone.';
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
            },
            'recorded_at': '2026-07-30T00:00:00.000Z',
          },
        },
      ],
    },
    htmlBytes: Uint8List.fromList(
      utf8.encode('<!doctype html><p>$validity</p>'),
    ),
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
    verifiedByteLength: 2048,
  );
}
