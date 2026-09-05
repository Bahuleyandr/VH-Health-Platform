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
  List<Map<String, dynamic>> missing = const [],
  List<String> orderableNow = const ['HCV'],
  bool caseStarted = false,
  bool autoManaged = true,
  List<String>? criticalItems,
}) {
  return CathCaseReadiness.fromJson({
    'readiness': [
      for (final type in _checkTypes)
        {
          'check_type': type,
          'status': type == 'labs' ? labsStatus : 'pending',
          'required': true,
          'metadata': type == 'labs'
              ? {'critical_warning': critical, 'auto_managed': autoManaged}
              : <String, dynamic>{},
        },
    ],
    'readiness_gate': {'ready': false},
    'lab_readiness': {
      'case_id': 42,
      'check_status': labsStatus,
      'auto_managed': autoManaged,
      'critical_warning': critical,
      'critical_items':
          criticalItems ?? (critical ? ['potassium'] : <String>[]),
      'items': items,
      'missing': missing,
      'orderable_now': orderableNow,
      'open_order_codes': <String>[],
      'case_started': caseStarted,
    },
  });
}

/// A degraded read: the case checks came back, the `lab_readiness` block did
/// not. The `labs` check still carries `critical_warning` in its own metadata,
/// so the confirm still has to gate — with nothing to name.
CathCaseReadiness _readinessWithoutLabBlock({bool critical = true}) {
  return CathCaseReadiness.fromJson({
    'readiness': [
      for (final type in _checkTypes)
        {
          'check_type': type,
          'status': 'pending',
          'required': true,
          'metadata': type == 'labs'
              ? {'critical_warning': critical, 'auto_managed': true}
              : <String, dynamic>{},
        },
    ],
    'readiness_gate': {'ready': false},
  });
}

Widget _wrap(CathReadinessDependencies deps, {int caseId = 42}) {
  return MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: CathReadinessChecklist(
          caseId: caseId,
          dependencies: deps,
          today: DateTime(2026, 9, 4),
        ),
      ),
    ),
  );
}

/// Opens the outside-result sheet's date picker and accepts the preselected
/// day. The field has NO default (see the "no report date" test), so every
/// successful save has to go through here.
Future<void> _pickReportDate(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('cath-external-date')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('OK'));
  await tester.pumpAndSettle();
}

Future<void> _chooseStatus(
  WidgetTester tester,
  String checkType,
  String label,
) async {
  await tester.tap(find.byKey(ValueKey('cath-readiness-status-$checkType')));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(PopupMenuItem<String>, label));
  await tester.pumpAndSettle();
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
              missing: [
                {'item': 'hcv', 'state': 'not_ordered'},
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

  // --- G1: card rebinding ---------------------------------------------------

  testWidgets(
    'rebinding the checklist to another case reloads instead of showing the '
    'previous case with the new id (G1)',
    (tester) async {
      final loads = <int>[];
      CathCaseReadiness forCase(int caseId) => _readiness(
        labsStatus: 'pending',
        items: [
          {
            'item_code': caseId == 1 ? 'hb' : 'hcv',
            'required': true,
            'state': 'not_ordered',
            'is_critical': false,
          },
        ],
        missing: [
          {'item': caseId == 1 ? 'hb' : 'hcv', 'state': 'not_ordered'},
        ],
      );
      final deps = CathReadinessDependencies(
        loadReadiness: (caseId) async {
          loads.add(caseId);
          return forCase(caseId);
        },
      );

      await tester.pumpWidget(_wrap(deps, caseId: 1));
      await tester.pumpAndSettle();
      expect(loads, [1]);
      expect(find.byKey(const ValueKey('cath-lab-item-hb')), findsOneWidget);

      // Same widget type at the same position: the State survives and only
      // `caseId` changes, exactly as a keyless ListView.builder row does when
      // `_cases` is replaced.
      await tester.pumpWidget(_wrap(deps, caseId: 2));
      await tester.pumpAndSettle();

      expect(loads, [1, 2]);
      expect(find.byKey(const ValueKey('cath-lab-item-hb')), findsNothing);
      expect(find.byKey(const ValueKey('cath-lab-item-hcv')), findsOneWidget);
    },
  );

  // --- G3: confirming a gate-changing status --------------------------------

  testWidgets(
    'passing a non-critical check is confirmed first and sends no notes (G3)',
    (tester) async {
      final calls = <List<Object?>>[];
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async => _readiness(labsStatus: 'pending'),
            updateCheck:
                (caseId, {required checkType, required status, notes}) async {
                  calls.add([caseId, checkType, status, notes]);
                },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await _chooseStatus(tester, 'consent', 'Pass');
      expect(
        find.byKey(const ValueKey('cath-readiness-confirm')),
        findsOneWidget,
      );
      expect(calls, isEmpty);

      await tester.tap(find.byKey(const ValueKey('cath-readiness-confirm-ok')));
      await tester.pumpAndSettle();

      expect(calls, [
        [42, 'consent', 'pass', null],
      ]);
    },
  );

  testWidgets('cancelling the confirmation writes nothing (G3)', (
    tester,
  ) async {
    var calls = 0;
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => _readiness(labsStatus: 'pending'),
          updateCheck:
              (caseId, {required checkType, required status, notes}) async {
                calls++;
              },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await _chooseStatus(tester, 'consent', 'Fail');
    await tester.tap(
      find.byKey(const ValueKey('cath-readiness-confirm-cancel')),
    );
    await tester.pumpAndSettle();

    expect(calls, 0);
    expect(find.byKey(const ValueKey('cath-readiness-confirm')), findsNothing);
  });

  testWidgets(
    'passing labs over a critical value names the items and refuses an empty '
    'reason (G3)',
    (tester) async {
      final calls = <List<Object?>>[];
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async => _readiness(
              labsStatus: 'pending',
              critical: true,
              items: [
                {
                  'item_code': 'potassium',
                  'required': true,
                  'state': 'result_final',
                  'is_critical': true,
                  'value_text': '6.9',
                  'unit': 'mmol/L',
                },
              ],
            ),
            updateCheck:
                (caseId, {required checkType, required status, notes}) async {
                  calls.add([caseId, checkType, status, notes]);
                },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await _chooseStatus(tester, 'labs', 'Pass');
      // The dialog must NAME the value being passed over, not just say
      // "critical": the backend files this as a safety review whose override
      // reason is whatever is typed below.
      expect(
        find.textContaining('Critical value present: Potassium'),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('cath-readiness-confirm-ok')));
      await tester.pumpAndSettle();
      expect(calls, isEmpty);
      expect(
        find.byKey(const ValueKey('cath-readiness-confirm')),
        findsOneWidget,
      );
      expect(find.text('A reason is required'), findsOneWidget);

      await tester.enterText(
        find.byKey(const ValueKey('cath-readiness-confirm-notes')),
        'Nephrology reviewed, dialysis booked post-procedure',
      );
      await tester.tap(find.byKey(const ValueKey('cath-readiness-confirm-ok')));
      await tester.pumpAndSettle();

      expect(calls, [
        [
          42,
          'labs',
          'pass',
          'Nephrology reviewed, dialysis booked post-procedure',
        ],
      ]);
    },
  );

  testWidgets(
    'a critical pass with no NAMED items falls back to the unnamed line, '
    'and still requires a reason (F1)',
    (tester) async {
      final calls = <List<Object?>>[];
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            // The backend empties `critical_items` for a role outside the
            // result audience while keeping `critical_warning` — the flag is
            // the safety signal, the names are the privileged part.
            loadReadiness: (_) async => _readiness(
              labsStatus: 'pending',
              critical: true,
              criticalItems: const <String>[],
            ),
            updateCheck:
                (caseId, {required checkType, required status, notes}) async {
                  calls.add([caseId, checkType, status, notes]);
                },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await _chooseStatus(tester, 'labs', 'Pass');
      expect(
        find.text(
          'A critical value is present. Give a reason for passing this check.',
        ),
        findsOneWidget,
      );
      // Never the named line with an empty slot in it.
      expect(find.textContaining('Critical value present:'), findsNothing);

      // The gate is the same gate: an unnamed critical value still cannot be
      // passed without a reason.
      await tester.tap(find.byKey(const ValueKey('cath-readiness-confirm-ok')));
      await tester.pumpAndSettle();
      expect(calls, isEmpty);
      expect(find.text('A reason is required'), findsOneWidget);

      await tester.enterText(
        find.byKey(const ValueKey('cath-readiness-confirm-notes')),
        'Consultant reviewed the flagged value',
      );
      await tester.tap(find.byKey(const ValueKey('cath-readiness-confirm-ok')));
      await tester.pumpAndSettle();
      expect(calls, [
        [42, 'labs', 'pass', 'Consultant reviewed the flagged value'],
      ]);
    },
  );

  testWidgets(
    'a degraded read with no lab block still gates the critical pass on the '
    'unnamed line (F1)',
    (tester) async {
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async => _readinessWithoutLabBlock(),
            updateCheck: (
              caseId, {
              required checkType,
              required status,
              notes,
            }) async {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      await _chooseStatus(tester, 'labs', 'Pass');
      expect(
        find.text(
          'A critical value is present. Give a reason for passing this check.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('Critical value present:'), findsNothing);
      expect(find.text('Reason'), findsOneWidget);
    },
  );

  testWidgets(
    'rebinding the list to another case while the confirm is open writes '
    'nothing (F2)',
    (tester) async {
      final calls = <List<Object?>>[];
      final caseId = ValueNotifier<int>(42);
      addTearDown(caseId.dispose);
      final deps = CathReadinessDependencies(
        loadReadiness: (id) async => _readiness(labsStatus: 'pending'),
        updateCheck: (id, {required checkType, required status, notes}) async {
          calls.add([id, checkType, status, notes]);
        },
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: ValueListenableBuilder<int>(
                valueListenable: caseId,
                builder: (context, id, _) => CathReadinessChecklist(
                  caseId: id,
                  dependencies: deps,
                  today: DateTime(2026, 9, 4),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await _chooseStatus(tester, 'consent', 'Pass');
      expect(
        find.byKey(const ValueKey('cath-readiness-confirm')),
        findsOneWidget,
      );

      // The worklist swapped underneath: a date change, a pull-to-refresh or
      // a realtime poll rebuilds this row against a DIFFERENT case while the
      // dialog is still up.
      caseId.value = 77;
      await tester.pump();

      await tester.enterText(
        find.byKey(const ValueKey('cath-readiness-confirm-notes')),
        'consent verified',
      );
      await tester.tap(find.byKey(const ValueKey('cath-readiness-confirm-ok')));
      await tester.pumpAndSettle();

      // The confirmation described case 42; the row now shows case 77. The
      // write is dropped rather than aimed at the wrong patient — and it is
      // dropped SILENTLY, since a failure snackbar would be about a case the
      // operator is no longer looking at.
      expect(calls, isEmpty);
      expect(find.byType(SnackBar), findsNothing);
    },
  );

  // --- G2: no clinical defaults in the outside-result sheet -----------------

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
              missing: [
                {'item': 'hcv', 'state': 'not_ordered'},
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

  testWidgets('outside serology result sheet posts the chosen qualitative '
      'token', (tester) async {
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
            missing: [
              {'item': 'hbsag', 'state': 'not_ordered'},
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
    await tester.tap(find.byKey(const ValueKey('cath-external-value-select')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Non-reactive').last);
    await tester.pumpAndSettle();
    await _pickReportDate(tester);
    await tester.tap(find.byKey(const ValueKey('cath-external-save')));
    await tester.pumpAndSettle();

    expect(sent, isNotNull);
    expect(sent!.item, 'hbsag');
    // The WIRE token the route matches against, chosen by a human.
    expect(sent!.valueText.toLowerCase(), 'non-reactive');
    expect(sent!.valueNumeric, isNull);
    expect(sent!.unit, isNull);
    expect(sent!.observedOn, '2026-09-04');
    expect(sent!.externalLabName, 'City Path Lab');
    expect(sentKey, isNotEmpty);
    expect(sent!.toJson().containsKey('value_numeric'), isFalse);
  });

  testWidgets(
    'a serology sheet with no result chosen does not save a negative marker '
    '(G2)',
    (tester) async {
      CathExternalResultDraft? sent;
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async => _readiness(
              labsStatus: 'pending',
              items: [
                {
                  'item_code': 'hiv',
                  'required': true,
                  'state': 'not_ordered',
                  'is_critical': false,
                },
              ],
              missing: [
                {'item': 'hiv', 'state': 'not_ordered'},
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

      await tester.tap(find.byKey(const ValueKey('cath-lab-external-hiv')));
      await tester.pumpAndSettle();
      // Everything else filled in: only the marker itself is unanswered, which
      // is precisely the form a pre-selected "Non-reactive" used to file as a
      // negative HIV result.
      await tester.enterText(
        find.byKey(const ValueKey('cath-external-lab')),
        'City Path Lab',
      );
      await _pickReportDate(tester);
      await tester.tap(find.byKey(const ValueKey('cath-external-save')));
      await tester.pumpAndSettle();

      expect(sent, isNull);
      expect(find.text('Choose a result'), findsOneWidget);
      expect(find.byKey(const ValueKey('cath-external-save')), findsOneWidget);
    },
  );

  testWidgets('an outside result with no report date does not save (G2b)', (
    tester,
  ) async {
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
            missing: [
              {'item': 'hb', 'state': 'not_ordered'},
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
    await tester.enterText(
      find.byKey(const ValueKey('cath-external-value')),
      '9.4',
    );
    await tester.enterText(
      find.byKey(const ValueKey('cath-external-lab')),
      'City Path Lab',
    );
    await tester.tap(find.byKey(const ValueKey('cath-external-save')));
    await tester.pumpAndSettle();

    // The report date drives the freshness rule behind auto-pass, so a blank
    // one must not be silently read as "today".
    expect(sent, isNull);
    expect(find.text('Choose the report date'), findsOneWidget);
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
            missing: [
              {'item': 'hb', 'state': 'not_ordered'},
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
    await _pickReportDate(tester);
    await tester.tap(find.byKey(const ValueKey('cath-external-save')));
    await tester.pumpAndSettle();
    expect(sent, isNull);
    expect(find.byKey(const ValueKey('cath-external-save')), findsOneWidget);

    // `9.40` is the same haemoglobin as `9.4`: the display value is rendered
    // from the parsed number, not from the keystrokes.
    await tester.enterText(
      find.byKey(const ValueKey('cath-external-value')),
      '9.40',
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
    expect(sent!.observedOn, '2026-09-04');
  });

  // --- waivers --------------------------------------------------------------

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
            missing: [
              {'item': 'hcv', 'state': 'not_ordered'},
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

    // A waiver without a reason is a 400 at the route, so the dialog holds —
    // and now SAYS why it held rather than silently ignoring the tap.
    await tester.tap(find.byKey(const ValueKey('cath-lab-waive-confirm')));
    await tester.pumpAndSettle();
    expect(waivedItem, isNull);
    expect(find.text('A reason is required'), findsOneWidget);

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

  testWidgets(
    'regression: the waive dialog outlives its own exit animation without a '
    'disposed-controller error',
    (tester) async {
      // The controller belongs to the DIALOG, not to the caller. Disposing one
      // created in `_askWaiveReason` from a `finally` after the await tore it
      // down while the route was still playing its exit animation and
      // rebuilding the field — "A TextEditingController was used after being
      // disposed". Pumping past the animation is what catches the regression;
      // stopping at the pop would not.
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
              missing: [
                {'item': 'hcv', 'state': 'not_ordered'},
              ],
            ),
            waiveItem: (
              caseId,
              item, {
              required reason,
              required idempotencyKey,
            }) async => _readiness(labsStatus: 'pass').labs!,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('cath-lab-waive-hcv')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('cath-lab-waive-reason')),
        'Emergency PCI',
      );
      await tester.tap(find.byKey(const ValueKey('cath-lab-waive-confirm')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    },
  );

  // --- S1: no dead end under external_results_count = false ----------------

  testWidgets(
    'an externally-recorded item the server still lists as missing keeps a '
    'waive exit and offers no second outside entry (S1)',
    (tester) async {
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async => _readiness(
              labsStatus: 'pending',
              items: [
                {
                  'item_code': 'hcv',
                  'required': true,
                  'state': 'external_recorded',
                  'is_critical': false,
                  'source': 'external',
                  'value_text': 'Non-reactive',
                  'observed_at': '2026-09-01T00:00:00.000Z',
                },
              ],
              // `external_results_count` off: the value is on record but the
              // gate still counts the item missing.
              missing: [
                {'item': 'hcv', 'state': 'external_recorded'},
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('cath-lab-waive-hcv')), findsOneWidget);
      expect(find.byKey(const ValueKey('cath-lab-external-hcv')), findsNothing);
    },
  );

  testWidgets(
    'an item the server does NOT list as missing offers no waiver (S1)',
    (tester) async {
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async => _readiness(
              labsStatus: 'pending',
              items: [
                {
                  'item_code': 'hcv',
                  'required': true,
                  'state': 'external_recorded',
                  'is_critical': false,
                  'source': 'external',
                  'value_text': 'Non-reactive',
                },
              ],
              missing: const [],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('cath-lab-waive-hcv')), findsNothing);
    },
  );

  // --- G4: idempotency keys -------------------------------------------------

  testWidgets(
    'a failed order-missing keeps its idempotency key for the retry (G4)',
    (tester) async {
      final keys = <String>[];
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
              missing: [
                {'item': 'hcv', 'state': 'not_ordered'},
              ],
            ),
            orderMissing: (caseId, {required idempotencyKey}) async {
              keys.add(idempotencyKey);
              if (keys.length == 1) {
                throw Exception('Network unreachable');
              }
              return _readiness(labsStatus: 'pending').labs!;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('cath-lab-order-missing')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cath-lab-order-missing')));
      await tester.pumpAndSettle();

      expect(keys, hasLength(2));
      // The retry must REPLAY the first attempt, not raise a second set of
      // orders: the key is only reset on success.
      expect(keys[0], keys[1]);
    },
  );

  testWidgets('two successful order-missing taps send different keys (G4)', (
    tester,
  ) async {
    final keys = <String>[];
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
            missing: [
              {'item': 'hcv', 'state': 'not_ordered'},
            ],
          ),
          orderMissing: (caseId, {required idempotencyKey}) async {
            keys.add(idempotencyKey);
            return _readiness(labsStatus: 'pending').labs!;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('cath-lab-order-missing')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-lab-order-missing')));
    await tester.pumpAndSettle();

    expect(keys, hasLength(2));
    // A second DELIBERATE order is a separate write and must not be swallowed
    // as a replay of the first.
    expect(keys[0], isNot(keys[1]));
  });

  // --- S2: a refresh that fails after a write ------------------------------

  testWidgets(
    'a refresh that fails after a write says so inline with a retry (S2)',
    (tester) async {
      var loads = 0;
      var failRefresh = true;
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async {
              loads++;
              if (loads > 1 && failRefresh) {
                throw Exception('Network unreachable');
              }
              return _readiness(
                labsStatus: 'pending',
                items: [
                  {
                    'item_code': 'hcv',
                    'required': true,
                    'state': 'not_ordered',
                    'is_critical': false,
                  },
                ],
                missing: [
                  {'item': 'hcv', 'state': 'not_ordered'},
                ],
              );
            },
            orderMissing: (caseId, {required idempotencyKey}) async =>
                _readiness(labsStatus: 'pending').labs!,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('cath-readiness-error')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('cath-lab-order-missing')));
      await tester.pumpAndSettle();

      // The rows are still on screen and still readable, so the only thing
      // that can say they are stale is this line.
      expect(
        find.byKey(const ValueKey('cath-readiness-error')),
        findsOneWidget,
      );
      expect(find.text('Could not load readiness'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('cath-readiness-status-labs')),
        findsOneWidget,
      );

      failRefresh = false;
      await tester.tap(find.byKey(const ValueKey('cath-readiness-retry')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('cath-readiness-error')), findsNothing);
    },
  );

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
            missing: [
              {'item': 'hb', 'state': 'not_ordered'},
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Waived: Emergency PCI'), findsOneWidget);
    // M1: a waiver is dated by its waiver, not labelled "As of".
    expect(find.text('Waived 2026-09-04'), findsOneWidget);
    expect(find.byKey(const ValueKey('cath-lab-order-missing')), findsNothing);
    expect(find.byKey(const ValueKey('cath-lab-external-hb')), findsNothing);
    expect(find.byKey(const ValueKey('cath-lab-waive-hb')), findsNothing);
  });

  testWidgets('a waived row offers the exit, and a plain row does not', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => _readiness(
            labsStatus: 'pass',
            items: [
              {
                'item_code': 'hcv',
                'required': true,
                'state': 'waived',
                'is_critical': false,
                'source': 'waiver',
                'waive_reason': 'Emergency PCI',
              },
              {
                'item_code': 'hb',
                'required': true,
                'state': 'result_final',
                'is_critical': false,
              },
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('cath-lab-unwaive-hcv')), findsOneWidget);
    // Not offered where there is no waiver to lift — the action is driven by
    // the item's own state, not by the server's missing[] (a waived item is
    // never missing, which is what makes that list the wrong gate here).
    expect(find.byKey(const ValueKey('cath-lab-unwaive-hb')), findsNothing);
    // ...and the waive action is not offered on a row that already carries one.
    expect(find.byKey(const ValueKey('cath-lab-waive-hcv')), findsNothing);
  });

  testWidgets('removing a waiver confirms first, then calls the dependency '
      'with an idempotency key', (tester) async {
    String? unwaivedItem;
    String? unwaiveKey;
    var calls = 0;
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => _readiness(
            labsStatus: 'pass',
            items: [
              {
                'item_code': 'hcv',
                'required': true,
                'state': 'waived',
                'is_critical': false,
                'source': 'waiver',
                'waive_reason': 'Emergency PCI',
              },
            ],
          ),
          unwaiveItem: (caseId, item, {required idempotencyKey}) async {
            calls += 1;
            unwaivedItem = item;
            unwaiveKey = idempotencyKey;
            return _readiness(labsStatus: 'pending').labs!;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('cath-lab-unwaive-hcv')));
    await tester.pumpAndSettle();
    // The confirmation is not decoration: lifting a waiver moves the start gate
    // in the RESTRICTIVE direction, so a mis-tap must not do it.
    expect(
      find.byKey(const ValueKey('cath-lab-unwaive-dialog')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('cath-lab-unwaive-cancel')));
    await tester.pumpAndSettle();
    expect(calls, 0);

    await tester.tap(find.byKey(const ValueKey('cath-lab-unwaive-hcv')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-lab-unwaive-confirm')));
    await tester.pumpAndSettle();

    expect(calls, 1);
    expect(unwaivedItem, 'hcv');
    expect(unwaiveKey, isNotEmpty);
  });

  // --- G4: the un-waive key has the same lifecycle as order-missing ---------
  //
  // The pair above it (order-missing) pins retained-on-failure and rotated-on-
  // success. Un-waive is the write where that lifecycle is load-bearing in BOTH
  // directions: the panel holds one attempt key per item, and the backend
  // releases the claim on CATH_LAB_READINESS_NOT_WAIVED precisely so a retry
  // under the retained key can run rather than replay a cached 409.

  testWidgets(
    'a failed un-waive keeps its idempotency key for the retry (G4)',
    (tester) async {
      final keys = <String>[];
      await tester.pumpWidget(
        _wrap(
          CathReadinessDependencies(
            loadReadiness: (_) async => _readiness(
              labsStatus: 'pass',
              items: [
                {
                  'item_code': 'hcv',
                  'required': true,
                  'state': 'waived',
                  'is_critical': false,
                  'source': 'waiver',
                  'waive_reason': 'Emergency PCI',
                },
              ],
            ),
            unwaiveItem: (caseId, item, {required idempotencyKey}) async {
              keys.add(idempotencyKey);
              if (keys.length == 1) {
                throw Exception('Network unreachable');
              }
              return _readiness(labsStatus: 'pending').labs!;
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      for (var attempt = 0; attempt < 2; attempt++) {
        await tester.tap(find.byKey(const ValueKey('cath-lab-unwaive-hcv')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('cath-lab-unwaive-confirm')),
        );
        await tester.pumpAndSettle();
      }

      expect(keys, hasLength(2));
      // The first attempt may have reached the server and been lost on the way
      // back. The retry must be the SAME logical command under the SAME key, so
      // a waiver that was already lifted is not lifted twice into two audit
      // rows — the key is only reset on success.
      expect(keys[0], keys[1]);
    },
  );

  testWidgets('two successful un-waives send different keys (G4)', (
    tester,
  ) async {
    final keys = <String>[];
    await tester.pumpWidget(
      _wrap(
        CathReadinessDependencies(
          loadReadiness: (_) async => _readiness(
            labsStatus: 'pass',
            items: [
              {
                'item_code': 'hcv',
                'required': true,
                'state': 'waived',
                'is_critical': false,
                'source': 'waiver',
                'waive_reason': 'Emergency PCI',
              },
            ],
          ),
          unwaiveItem: (caseId, item, {required idempotencyKey}) async {
            keys.add(idempotencyKey);
            return _readiness(labsStatus: 'pending').labs!;
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    for (var attempt = 0; attempt < 2; attempt++) {
      await tester.tap(find.byKey(const ValueKey('cath-lab-unwaive-hcv')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('cath-lab-unwaive-confirm')));
      await tester.pumpAndSettle();
    }

    expect(keys, hasLength(2));
    // A waiver re-applied and lifted again is a SECOND withdrawal, not a replay
    // of the first: sharing the key would hand back the first lift's response
    // and the second waiver would still stand.
    expect(keys[0], isNot(keys[1]));
  });

  testWidgets('a started case offers no way to remove a waiver either', (
    tester,
  ) async {
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
                'waive_reason': 'Emergency PCI',
              },
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The backend answers 409 CATH_LAB_READINESS_CASE_STARTED here, and the
    // panel must not offer the tap that earns it: the pre-procedure record is
    // what the team knew BEFORE the case, in both directions.
    expect(find.text('Waived: Emergency PCI'), findsOneWidget);
    expect(find.byKey(const ValueKey('cath-lab-unwaive-hcv')), findsNothing);
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
      // A pin that falls back to a local literal is not a pin: it passes by
      // comparing this file to itself and reports GREEN for a vocabulary
      // nobody checked. Say the check did not run instead.
      markTestSkipped(
        'apps/backend not reachable from ${Directory.current.path}; the item '
        'code pin cannot be verified from this checkout.',
      );
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
          'LAB_ANALYTE_ITEMS (which is cathLabReadinessRules.ITEM_CODES) '
          'in the same order — the checklist renders one row per code and '
          'localises each by name.',
    );
  });

  test(
    'cathReadinessItemStates is pinned against the backend ITEM_STATES source '
    '(apps/backend/src/services/clinical/cathLabReadinessRules.js)',
    () {
      final repoRoot = _findRepoRoot(Directory.current);
      final backendFile = repoRoot == null
          ? null
          : File(
              '${repoRoot.path}/apps/backend/src/services/clinical/'
              'cathLabReadinessRules.js',
            );
      if (backendFile == null || !backendFile.existsSync()) {
        markTestSkipped(
          'apps/backend not reachable from ${Directory.current.path}; the item '
          'state pin cannot be verified from this checkout.',
        );
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
            'ITEM_STATES not found in cathLabReadinessRules.js — has it been '
            'renamed or restructured? It moved there from '
            'cathLabReadinessService.js when the readiness service was split '
            'into rules / persistence / actions.',
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
            'ITEM_STATES in cathLabReadinessRules.js, in the same order — a '
            'state with no entry here renders as a humanised code with no '
            'colour, which is how "critical, not ordered" comes to look calm.',
      );
    },
  );

  test('the server missing[] is parsed, not recomputed from the items', () {
    final labs = _readiness(
      labsStatus: 'pending',
      items: [
        {
          'item_code': 'hcv',
          'required': true,
          'state': 'external_recorded',
          'is_critical': false,
        },
      ],
      missing: [
        {'item': 'hcv', 'state': 'external_recorded'},
      ],
    ).labs!;

    // The item reads as available to the client (a value IS on record) while
    // the server still counts it missing, which is exactly the tenant setting
    // the client cannot see.
    expect(labs.items.single.available, isTrue);
    expect(labs.missingItemCodes, {'hcv'});
    expect(labs.missing.single.state, 'external_recorded');
  });
}
