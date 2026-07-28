import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/models/offline_write_entry.dart';
import 'package:vhhealth_core/services/offline_write_containment.dart';
import 'package:vhhealth_core/widgets/offline_sync_badge.dart';

OfflineWriteEntry _entry({
  int id = 41,
  String endpoint = '/clinical/mar/7/administer-with-scan',
  String method = 'POST',
  OfflineWriteStatus status = OfflineWriteStatus.needsReview,
  int retryCount = 2,
  String? reviewReasonCode = 'contained_mar_administration',
  String? conflictReason,
  bool isSkipped = false,
  int? blockerRowId,
  DateTime? handoffAttestedAt,
  String? handoffAttestedBy,
  String? staffId = 'staff-17',
  String? tenantId = 'tenant-a',
  int? encryptionVersion = 1,
  String? reconciliationOwnerId = 'role:clinical_safety_lead',
}) {
  return OfflineWriteEntry(
    id: id,
    endpoint: endpoint,
    method: method,
    createdAt: DateTime(2026, 7, 28, 9, 30),
    retryCount: retryCount,
    contextLabel: 'Paracetamol for Bed 4',
    status: status,
    conflictReason: conflictReason,
    staffId: staffId,
    tenantId: tenantId,
    encryptionVersion: encryptionVersion,
    reviewReasonCode: reviewReasonCode,
    reconciliationOwnerId: reconciliationOwnerId,
    handoffAttestedAt: handoffAttestedAt,
    handoffAttestedBy: handoffAttestedBy,
    classification: OfflineWriteContainment.classify(
      method: method,
      path: endpoint,
    ),
    isSkipped: isSkipped,
    blockerRowId: blockerRowId,
    blockerReasonCode: isSkipped ? 'partition_blocked' : null,
  );
}

Future<void> _pumpRow(
  WidgetTester tester,
  OfflineWriteEntry entry, {
  Future<void> Function()? onRetry,
  OfflineWriteDiscardCallback? onDiscard,
  Future<void> Function()? onAttest,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: OfflineWriteStatusRow(
            entry: entry,
            onRetry: onRetry,
            onDiscard: onDiscard,
            onAttest: onAttest,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('needs-review row shows every reconciliation field in text', (
    tester,
  ) async {
    await _pumpRow(tester, _entry(), onAttest: () async {});

    expect(find.text('MAR administration'), findsOneWidget);
    expect(find.text('Paracetamol for Bed 4'), findsNWidgets(2));
    expect(
      find.text('POST /clinical/mar/7/administer-with-scan'),
      findsOneWidget,
    );
    expect(find.text('28 Jul 2026 09:30'), findsOneWidget);
    expect(find.text('Needs review'), findsNWidgets(2));
    expect(
      find.text('MAR administration requires reconciliation'),
      findsOneWidget,
    );
    expect(find.text('None'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    expect(find.text('staff-17'), findsOneWidget);
    expect(find.text('Clinical safety lead'), findsOneWidget);
    expect(find.text('Record attested handoff'), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    expect(find.text('Discard'), findsNothing);
  });

  testWidgets('contained rows name the exact department paper form set', (
    tester,
  ) async {
    final cases =
        <
          (
            String method,
            String endpoint,
            OfflineWriteActionFamily family,
            String key,
            String paperSet,
          )
        >[
          (
            'POST',
            '/prescriptions/create',
            OfflineWriteActionFamily.prescriptionCreate,
            'c0a.offline_fallback.paper_set.opd_prescription_pads',
            'OPD prescription pads',
          ),
          (
            'POST',
            '/emr/orders',
            OfflineWriteActionFamily.drugChartOrder,
            'c0a.offline_fallback.paper_set.inpatient_drug_charts',
            'inpatient drug charts',
          ),
          (
            'POST',
            '/clinical/mar/7/administer-with-scan',
            OfflineWriteActionFamily.marAdministration,
            'c0a.offline_fallback.paper_set.mar_sheets',
            'MAR sheets',
          ),
          (
            'POST',
            '/lab/samples/7/collect',
            OfflineWriteActionFamily.specimenCollection,
            'c0a.offline_fallback.paper_set.laboratory_requisition_forms',
            'laboratory requisition forms',
          ),
          (
            'POST',
            '/blood-bank/7/verify-bedside',
            OfflineWriteActionFamily.transfusionVerification,
            'c0a.offline_fallback.paper_set.blood_bank_verification_slips',
            'blood-bank verification slips',
          ),
          (
            'POST',
            '/emr/notes',
            OfflineWriteActionFamily.authoritativeNote,
            'c0a.offline_fallback.paper_set.nursing_note_forms',
            'nursing note forms',
          ),
        ];

    for (final (method, endpoint, family, key, paperSet) in cases) {
      expect(offlinePaperFormSetKeyForFamily(family), key);
      await _pumpRow(tester, _entry(method: method, endpoint: endpoint));
      expect(find.text('Paper form set'), findsOneWidget);
      expect(find.text(paperSet), findsOneWidget);
    }
  });

  testWidgets('controls and unknown actions do not claim a paper form set', (
    tester,
  ) async {
    final cases = <(String method, String endpoint)>[
      ('POST', '/health/records'),
      ('PUT', '/emr/notes/draft'),
      ('POST', '/unrecognized/action'),
    ];

    for (final (method, endpoint) in cases) {
      await _pumpRow(tester, _entry(method: method, endpoint: endpoint));
      expect(find.text('Paper form set'), findsNothing);
    }
    expect(
      offlinePaperFormSetKeyForFamily(OfflineWriteActionFamily.vitals),
      isNull,
    );
    expect(
      offlinePaperFormSetKeyForFamily(OfflineWriteActionFamily.noteDraft),
      isNull,
    );
    expect(
      offlinePaperFormSetKeyForFamily(OfflineWriteActionFamily.unknown),
      isNull,
    );
  });

  testWidgets('attestation requires confirmation and cancel invokes nothing', (
    tester,
  ) async {
    var attestCount = 0;
    await _pumpRow(tester, _entry(), onAttest: () async => attestCount++);

    await tester.tap(find.text('Record attested handoff'));
    await tester.pumpAndSettle();
    expect(find.textContaining('transferred to paper'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(attestCount, 0);

    await tester.tap(find.text('Record attested handoff'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm handoff'));
    await tester.pumpAndSettle();
    expect(attestCount, 1);
  });

  testWidgets('attested handoff is visible and exposes no row action', (
    tester,
  ) async {
    await _pumpRow(
      tester,
      _entry(
        handoffAttestedAt: DateTime(2026, 7, 28, 10, 45),
        handoffAttestedBy: 'staff-17',
      ),
      onRetry: () async {},
      onDiscard: (_) async {},
      onAttest: () async {},
    );

    expect(find.text('Needs review · handoff attested'), findsNWidgets(2));
    expect(
      find.text('Attested by staff-17 at 28 Jul 2026 10:45'),
      findsOneWidget,
    );
    expect(find.text('Record attested handoff'), findsNothing);
    expect(find.text('Retry'), findsNothing);
    expect(find.text('Discard'), findsNothing);
  });

  testWidgets('exhausted and skipped rows expose no retry or discard', (
    tester,
  ) async {
    await _pumpRow(
      tester,
      _entry(
        status: OfflineWriteStatus.needsReview,
        retryCount: 6,
        reviewReasonCode: 'retry_exhausted',
      ),
      onRetry: () async {},
      onDiscard: (_) async {},
    );
    expect(find.text('Automatic retry limit reached'), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    expect(find.text('Discard'), findsNothing);

    await _pumpRow(
      tester,
      _entry(
        endpoint: '/health/records',
        status: OfflineWriteStatus.pending,
        reviewReasonCode: null,
        isSkipped: true,
        blockerRowId: 13,
      ),
      onRetry: () async {},
      onDiscard: (_) async {},
    );
    expect(find.text('Skipped this pass'), findsNWidgets(2));
    expect(find.textContaining('Earlier offline item #13'), findsOneWidget);
    expect(find.textContaining('partition blocked'), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    expect(find.text('Discard'), findsNothing);
  });

  testWidgets('service-eligible vitals conflict confirms with exact copy', (
    tester,
  ) async {
    var retryCount = 0;
    final discardConfirmations = <bool>[];
    await _pumpRow(
      tester,
      _entry(
        endpoint: '/health/records',
        status: OfflineWriteStatus.conflict,
        reviewReasonCode: null,
        conflictReason: 'Chart version changed',
      ),
      onRetry: () async => retryCount++,
      onDiscard: (confirmed) async => discardConfirmations.add(confirmed),
    );

    expect(find.text('Conflict'), findsNWidgets(2));
    expect(find.text('Chart version changed'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(retryCount, 1);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Vitals not recorded on the server — review needed. Review the patient chart before discarding.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Discard after reconciliation'));
    await tester.pumpAndSettle();
    expect(discardConfirmations, [isTrue]);
  });
}
