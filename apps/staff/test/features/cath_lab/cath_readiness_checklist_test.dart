import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_readiness_models.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_readiness_checklist.dart';

const _checkTypes = [
  'consent',
  'labs',
  'allergy_renal_risk',
  'anticoagulation',
  'blood_bank',
  'equipment',
  'implants_device_rep',
  'timeout',
];

/// The vocabularies as of the last time a human read `ITEM_CODES` /
/// `ITEM_STATES` in the backend and copied them here. Used only as a fallback
/// when the backend source is not reachable from the test runner's checkout —
/// the real pin below reads those sources directly.
const _knownItemCodes = [
  'hb',
  'platelets',
  'creatinine',
  'potassium',
  'hiv',
  'hbsag',
  'hcv',
];

const _knownItemStates = [
  'result_final',
  'result_preliminary',
  'external_recorded',
  'sample_sent_awaiting_result',
  'ordered_awaiting_sample',
  'not_ordered',
  'stale',
  'waived',
];

/// Walks up from [start] looking for a directory containing `apps/backend` —
/// the repo root — so the pins below work whether the runner's CWD is the
/// workspace root or `apps/staff` (which is where `melos exec` runs).
Directory? _findRepoRoot(Directory start) {
  var dir = start;
  for (var i = 0; i < 8; i++) {
    if (Directory('${dir.path}/apps/backend').existsSync()) return dir;
    final parent = dir.parent;
    if (parent.path == dir.path) return null;
    dir = parent;
  }
  return null;
}

CathCaseReadiness _readiness({
  required String labsStatus,
  bool critical = false,
  List<Map<String, dynamic>> items = const [],
  List<String> orderableNow = const ['HCV'],
  bool caseStarted = false,
}) {
  return CathCaseReadiness.fromJson({
    'readiness': [
      for (final type in _checkTypes)
        {
          'check_type': type,
          'status': type == 'labs' ? labsStatus : 'pending',
          'required': true,
          'metadata': type == 'labs'
              ? {'critical_warning': critical, 'auto_managed': true}
              : <String, dynamic>{},
        },
    ],
    'readiness_gate': {'ready': false},
    'lab_readiness': {
      'case_id': 42,
      'check_status': labsStatus,
      'auto_managed': true,
      'critical_warning': critical,
      'critical_items': critical ? ['potassium'] : <String>[],
      'items': items,
      'missing': <String>[],
      'orderable_now': orderableNow,
      'open_order_codes': <String>[],
      'case_started': caseStarted,
    },
  });
}

Widget _wrap(CathReadinessDependencies deps) {
  return MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: CathReadinessChecklist(
          caseId: 42,
          dependencies: deps,
          today: DateTime(2026, 9, 4),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets(
    'renders all eight checks with a status control, and the critical badge '
    'on labs',
    (tester) async {
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async => _readiness(
              labsStatus: 'pass',
              critical: true,
              items: [
                {
                  'item_code': 'potassium',
                  'required': true,
                  'state': 'result_final',
                  'is_critical': true,
                  'value_text': '6.3',
                  'unit': 'mmol/L',
                  'abnormal_flag': 'HH',
                },
                {
                  'item_code': 'hcv',
                  'required': true,
                  'state': 'not_ordered',
                  'is_critical': false,
                },
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      for (final type in _checkTypes) {
        expect(
          find.byKey(ValueKey('cath-readiness-status-$type')),
          findsOneWidget,
        );
      }
      expect(
        find.byKey(const ValueKey('cath-readiness-critical-badge')),
        findsOneWidget,
      );
      expect(find.text('Critical value'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('cath-lab-item-potassium')),
        findsOneWidget,
      );
      expect(find.text('6.3 mmol/L'), findsOneWidget);
      expect(find.text('Not ordered'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('cath-lab-order-missing')),
        findsOneWidget,
      );
      // A resolved value needs no outside entry; a missing one does.
      expect(
        find.byKey(const ValueKey('cath-lab-external-potassium')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('cath-lab-external-hcv')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('cath-lab-waive-hcv')), findsOneWidget);
    },
  );

  testWidgets('order missing labs calls the dependency with an idempotency '
      'key and reloads', (tester) async {
    var ordered = 0;
    var loads = 0;
    String? sentKey;
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async {
            loads++;
            return _readiness(
              labsStatus: 'pending',
              items: [
                {
                  'item_code': 'hcv',
                  'required': true,
                  'state': loads > 1
                      ? 'ordered_awaiting_sample'
                      : 'not_ordered',
                  'is_critical': false,
                  'ordered_at': '2026-09-04T06:15:00.000Z',
                },
              ],
            );
          },
          orderMissing: (caseId, {required idempotencyKey}) async {
            ordered++;
            sentKey = idempotencyKey;
            expect(caseId, 42);
            expect(idempotencyKey, isNotEmpty);
            return _readiness(labsStatus: 'pending').labs!;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('cath-lab-order-missing')));
    await tester.pumpAndSettle();

    expect(ordered, 1);
    expect(sentKey, isNotNull);
    expect(loads, greaterThanOrEqualTo(2));
    expect(find.text('Ordered, sample not collected'), findsOneWidget);
  });

  testWidgets('outside serology result sheet posts a qualitative draft', (
    tester,
  ) async {
    CathExternalResultDraft? sent;
    String? sentKey;
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => _readiness(
            labsStatus: 'pending',
            items: [
              {
                'item_code': 'hbsag',
                'required': true,
                'state': 'not_ordered',
                'is_critical': false,
              },
            ],
          ),
          recordExternal: (caseId, draft, {required idempotencyKey}) async {
            sent = draft;
            sentKey = idempotencyKey;
            return _readiness(labsStatus: 'pass').labs!;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('cath-lab-external-hbsag')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('cath-external-lab')),
      'City Path Lab',
    );
    await tester.tap(find.byKey(const ValueKey('cath-external-save')));
    await tester.pumpAndSettle();

    expect(sent, isNotNull);
    expect(sent!.item, 'hbsag');
    // The dropdown default, as the WIRE token the route matches against.
    expect(sent!.valueText.toLowerCase(), 'non-reactive');
    expect(sent!.valueNumeric, isNull);
    expect(sent!.unit, isNull);
    expect(sent!.observedOn, '2026-09-04');
    expect(sent!.externalLabName, 'City Path Lab');
    expect(sentKey, isNotEmpty);
    expect(sent!.toJson().containsKey('value_numeric'), isFalse);
  });

  testWidgets('a quantitative outside result sends the number twice with a '
      'unit, and refuses a blank value', (tester) async {
    CathExternalResultDraft? sent;
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => _readiness(
            labsStatus: 'pending',
            items: [
              {
                'item_code': 'hb',
                'required': true,
                'state': 'not_ordered',
                'is_critical': false,
              },
            ],
          ),
          recordExternal: (caseId, draft, {required idempotencyKey}) async {
            sent = draft;
            return _readiness(labsStatus: 'pass').labs!;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('cath-lab-external-hb')));
    await tester.pumpAndSettle();

    // The backend refuses a quantitative entry without a finite, non-negative
    // number, so the sheet must not send one: saving empty keeps it open.
    await tester.enterText(
      find.byKey(const ValueKey('cath-external-lab')),
      'City Path Lab',
    );
    await tester.tap(find.byKey(const ValueKey('cath-external-save')));
    await tester.pumpAndSettle();
    expect(sent, isNull);
    expect(find.byKey(const ValueKey('cath-external-save')), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('cath-external-value')),
      '9.4',
    );
    await tester.tap(find.byKey(const ValueKey('cath-external-save')));
    await tester.pumpAndSettle();

    expect(sent, isNotNull);
    expect(sent!.item, 'hb');
    expect(sent!.valueNumeric, 9.4);
    expect(sent!.valueText, '9.4');
    // Prefilled from the item, so the operator does not have to type it.
    expect(sent!.unit, 'g/dL');
    expect(sent!.toJson()['value_numeric'], 9.4);
  });

  testWidgets('waiving an item posts a reason with an idempotency key', (
    tester,
  ) async {
    String? waivedItem;
    String? waivedReason;
    String? waiveKey;
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => _readiness(
            labsStatus: 'pending',
            items: [
              {
                'item_code': 'hcv',
                'required': true,
                'state': 'not_ordered',
                'is_critical': false,
              },
            ],
          ),
          waiveItem:
              (caseId, item, {required reason, required idempotencyKey}) async {
                waivedItem = item;
                waivedReason = reason;
                waiveKey = idempotencyKey;
                return _readiness(labsStatus: 'pass').labs!;
              },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('cath-lab-waive-hcv')));
    await tester.pumpAndSettle();

    // A waiver without a reason is a 400 at the route, so the dialog holds.
    await tester.tap(find.byKey(const ValueKey('cath-lab-waive-confirm')));
    await tester.pumpAndSettle();
    expect(waivedItem, isNull);

    await tester.enterText(
      find.byKey(const ValueKey('cath-lab-waive-reason')),
      'Emergency PCI, sample not obtainable',
    );
    await tester.tap(find.byKey(const ValueKey('cath-lab-waive-confirm')));
    await tester.pumpAndSettle();

    expect(waivedItem, 'hcv');
    expect(waivedReason, 'Emergency PCI, sample not obtainable');
    expect(waiveKey, isNotEmpty);
  });

  testWidgets('a started case shows the waive reason but offers no write '
      'actions', (tester) async {
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => _readiness(
            labsStatus: 'pass',
            caseStarted: true,
            items: [
              {
                'item_code': 'hcv',
                'required': true,
                'state': 'waived',
                'is_critical': false,
                'source': 'waiver',
                'waived_at': '2026-09-04T05:00:00.000Z',
                'waive_reason': 'Emergency PCI',
              },
              {
                'item_code': 'hb',
                'required': true,
                'state': 'not_ordered',
                'is_critical': false,
              },
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Waived: Emergency PCI'), findsOneWidget);
    expect(find.byKey(const ValueKey('cath-lab-order-missing')), findsNothing);
    expect(find.byKey(const ValueKey('cath-lab-external-hb')), findsNothing);
    expect(find.byKey(const ValueKey('cath-lab-waive-hb')), findsNothing);
  });

  testWidgets('nothing renders when the case carries no readiness block', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async =>
              CathCaseReadiness.fromJson(const <String, dynamic>{}),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Pre-procedure checks'), findsNothing);
    expect(
      find.byKey(const ValueKey('cath-readiness-status-labs')),
      findsNothing,
    );
  });

  testWidgets('a failed load says so instead of rendering an empty checklist', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => throw Exception('boom'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Could not load readiness'), findsOneWidget);
  });

  test('cathReadinessItemCodes is pinned against the backend LAB_ANALYTE_ITEMS '
      'source (apps/backend/src/services/lab/labAnalyteCodes.js)', () {
    final repoRoot = _findRepoRoot(Directory.current);
    final backendFile = repoRoot == null
        ? null
        : File(
            '${repoRoot.path}/apps/backend/src/services/lab/'
            'labAnalyteCodes.js',
          );
    if (backendFile == null || !backendFile.existsSync()) {
      expect(cathReadinessItemCodes, _knownItemCodes);
      return;
    }

    final source = backendFile.readAsStringSync();
    final match = RegExp(
      r'LAB_ANALYTE_ITEMS\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);',
    ).firstMatch(source);
    expect(
      match,
      isNotNull,
      reason:
          'LAB_ANALYTE_ITEMS not found in labAnalyteCodes.js — has it been '
          'renamed or restructured?',
    );
    final backendCodes = RegExp(
      r'^\s{2}(\w+): item\(',
      multiLine: true,
    ).allMatches(match!.group(1)!).map((m) => m.group(1)!).toList();

    expect(backendCodes, isNotEmpty);
    expect(
      cathReadinessItemCodes,
      backendCodes,
      reason:
          'cathReadinessItemCodes in cath_readiness_models.dart must match '
          'LAB_ANALYTE_ITEMS (which is cathLabReadinessService.ITEM_CODES) '
          'in the same order — the checklist renders one row per code and '
          'localises each by name.',
    );
  });

  test(
    'cathReadinessItemStates is pinned against the backend ITEM_STATES source '
    '(apps/backend/src/services/clinical/cathLabReadinessService.js)',
    () {
      final repoRoot = _findRepoRoot(Directory.current);
      final backendFile = repoRoot == null
          ? null
          : File(
              '${repoRoot.path}/apps/backend/src/services/clinical/'
              'cathLabReadinessService.js',
            );
      if (backendFile == null || !backendFile.existsSync()) {
        expect(cathReadinessItemStates, _knownItemStates);
        return;
      }

      final source = backendFile.readAsStringSync();
      final match = RegExp(
        r'ITEM_STATES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)',
      ).firstMatch(source);
      expect(
        match,
        isNotNull,
        reason:
            'ITEM_STATES not found in cathLabReadinessService.js — has it been '
            'renamed or restructured?',
      );
      final backendStates = RegExp(r"'([^']+)'")
          .allMatches(match!.group(1)!)
          .map((m) => m.group(1)!)
          .toList();

      expect(backendStates, isNotEmpty);
      expect(
        cathReadinessItemStates,
        backendStates,
        reason:
            'cathReadinessItemStates in cath_readiness_models.dart must match '
            'ITEM_STATES in cathLabReadinessService.js, in the same order — a '
            'state with no entry here renders as a humanised code with no '
            'colour, which is how "critical, not ordered" comes to look calm.',
      );
    },
  );
}
