import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/services/cath_lab_api_service.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_quick_wins_panel.dart';

const _blood = CathBloodReadinessEvidence(
  bloodRequestId: 88,
  requestStatus: 'cross_matched',
  crossMatchStatus: 'compatible',
  bloodGroup: 'O+',
  component: 'prbc',
  units: 2,
);

const _consent = CathConsentReadinessEvidence(
  consentId: 501,
  consentType: 'cath_procedure',
  artifactPath: '/api/v1/consent/501/pdf',
);

const _preCath = CathOrderSetSlot(
  orderSetId: 31,
  title: 'Pre-cath bundle',
  version: 2,
  itemCount: 3,
);

const _postCath = CathOrderSetSlot(
  orderSetId: 32,
  title: 'Post-cath bundle',
  version: 1,
  itemCount: 4,
);

CathCaseQuickWins _quickWins({
  CathBloodReadinessEvidence? blood,
  CathConsentReadinessEvidence? consent,
  CathOrderSetSlot? preCath,
  CathOrderSetSlot? postCath,
}) {
  return CathCaseQuickWins(
    caseId: 42,
    bloodEvidence: blood,
    consentEvidence: consent,
    preCathOrderSet: preCath,
    postCathOrderSet: postCath,
  );
}

Widget _wrap(Widget child) {
  return MaterialApp(
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );
}

void main() {
  testWidgets('parses the quick-wins payload defensively', (tester) async {
    final parsed = CathCaseQuickWins.fromJson(const {
      'case_id': 42,
      'readiness_evidence': {
        'blood_bank': {
          'blood_request_id': 88,
          'request_status': 'cross_matched',
          'cross_match_status': 'compatible',
        },
        'consent': null,
      },
      'order_sets': {
        'pre_cath': {'order_set_id': 31, 'title': 'Pre', 'item_count': 2},
        'post_cath': null,
      },
    });
    expect(parsed.caseId, 42);
    expect(parsed.bloodEvidence!.crossMatchCompatible, isTrue);
    expect(parsed.consentEvidence, isNull);
    expect(parsed.preCathOrderSet!.orderSetId, 31);
    expect(parsed.postCathOrderSet, isNull);

    final empty = CathCaseQuickWins.fromJson(const {'case_id': 7});
    expect(empty.bloodEvidence, isNull);
    expect(empty.preCathOrderSet, isNull);
  });

  testWidgets('renders evidence chips and both order-set buttons when mapped', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathQuickWinsPanel(
          caseId: 42,
          initiallyExpanded: true,
          dependencies: CathQuickWinsDependencies(
            loadQuickWins: (_) async => _quickWins(
              blood: _blood,
              consent: _consent,
              preCath: _preCath,
              postCath: _postCath,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Crossmatch: Compatible'), findsOneWidget);
    expect(find.text('Signed consent on file'), findsOneWidget);
    expect(find.text('Apply pre-cath order set'), findsOneWidget);
    expect(find.text('Apply post-cath order set'), findsOneWidget);
  });

  testWidgets('inert tenant: no chips fabricated and no order-set buttons', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathQuickWinsPanel(
          caseId: 42,
          initiallyExpanded: true,
          dependencies: CathQuickWinsDependencies(
            loadQuickWins: (_) async => _quickWins(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('No live evidence found — checks stay manual'),
      findsOneWidget,
    );
    expect(find.text('Apply pre-cath order set'), findsNothing);
    expect(find.text('Apply post-cath order set'), findsNothing);
    expect(find.textContaining('Crossmatch:'), findsNothing);
  });

  testWidgets('button visibility follows the mapped slots exactly', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        CathQuickWinsPanel(
          caseId: 42,
          initiallyExpanded: true,
          dependencies: CathQuickWinsDependencies(
            loadQuickWins: (_) async => _quickWins(preCath: _preCath),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Apply pre-cath order set'), findsOneWidget);
    expect(find.text('Apply post-cath order set'), findsNothing);
  });

  testWidgets('does not fetch until expanded, then loads once', (tester) async {
    var loads = 0;
    await tester.pumpWidget(
      _wrap(
        CathQuickWinsPanel(
          caseId: 42,
          dependencies: CathQuickWinsDependencies(
            loadQuickWins: (_) async {
              loads += 1;
              return _quickWins(blood: _blood);
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(loads, 0);

    await tester.tap(find.text('Live evidence & order sets'));
    await tester.pumpAndSettle();
    expect(loads, 1);
    expect(find.text('Crossmatch: Compatible'), findsOneWidget);
  });

  testWidgets('apply flow confirms before staging through CPOE', (
    tester,
  ) async {
    final applied = <String>[];
    await tester.pumpWidget(
      _wrap(
        CathQuickWinsPanel(
          caseId: 42,
          initiallyExpanded: true,
          dependencies: CathQuickWinsDependencies(
            loadQuickWins: (_) async => _quickWins(preCath: _preCath),
            applyOrderSet: (caseId, slot) async {
              applied.add('$caseId:$slot');
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Apply pre-cath order set'));
    await tester.pumpAndSettle();
    expect(find.text('Apply order set?'), findsOneWidget);

    // Cancel first: nothing staged.
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(applied, isEmpty);

    await tester.tap(find.text('Apply pre-cath order set'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    expect(applied, ['42:pre_cath']);
    expect(find.text('Order set staged through CPOE'), findsOneWidget);
  });

  testWidgets('refresh action persists evidence and reloads', (tester) async {
    var refreshes = 0;
    var loads = 0;
    await tester.pumpWidget(
      _wrap(
        CathQuickWinsPanel(
          caseId: 42,
          initiallyExpanded: true,
          dependencies: CathQuickWinsDependencies(
            loadQuickWins: (_) async {
              loads += 1;
              return _quickWins(blood: _blood);
            },
            refreshEvidence: (_) async {
              refreshes += 1;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(loads, 1);

    await tester.tap(find.byIcon(Icons.sync));
    await tester.pumpAndSettle();
    expect(refreshes, 1);
    expect(loads, 2);
    expect(
      find.text('Evidence attached to the readiness checklist'),
      findsOneWidget,
    );
  });
}
