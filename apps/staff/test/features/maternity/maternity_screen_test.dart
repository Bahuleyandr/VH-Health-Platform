import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/maternity/screens/maternity_screen.dart';
import 'package:vhhealth_staff/features/maternity/screens/partograph_entry_screen.dart';
import 'package:vhhealth_staff/features/maternity/screens/partograph_view_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

http.Response _ok(Object data) => http.Response(
  jsonEncode({'success': true, 'data': data}),
  200,
  headers: {'content-type': 'application/json'},
);

void main() {
  final strings = AppStrings.forLocale(const Locale('en'));
  late GoRouter router;
  late int boardReads;
  late int chartReads;
  late List<Map<String, dynamic>> writes;
  late Future<http.Response> Function() boardResponse;

  http.Response currentBoard() => _ok([
    {
      'id': 7,
      'patient_uid': 'synthetic-patient',
      'gravida': 1,
      'parity': 0,
      'cervix_dilation_cm': writes.isEmpty ? 4 : 5,
    },
  ]);

  Future<void> openBoard(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    expect(boardReads, 1);
    expect(find.text('4 cm'), findsOneWidget);
  }

  Future<void> openChart(WidgetTester tester) async {
    await tester.tap(find.text(strings.maternityActionPartographChart));
    await tester.pumpAndSettle();
    expect(find.byType(PartographViewScreen), findsOneWidget);
    expect(chartReads, 1);
  }

  Future<void> saveEntry(WidgetTester tester) async {
    expect(find.byType(PartographEntryScreen), findsOneWidget);
    await tester.enterText(
      find.widgetWithText(TextFormField, strings.partographCervixDilation),
      '5',
    );
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.scrollUntilVisible(
      find.byType(FilledButton),
      500,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(writes, [
      {'labor_admission_id': 7, 'cervix_dilation_cm': 5},
    ]);
  }

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    boardReads = 0;
    chartReads = 0;
    writes = [];
    boardResponse = () async => currentBoard();
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        final path = request.url.path;
        if (request.method == 'POST') {
          expect(path, endsWith('/maternity/partograph'));
          writes.add(jsonDecode(request.body) as Map<String, dynamic>);
          return _ok({'on_alert_line': false, 'on_action_line': false});
        }
        expect(request.method, 'GET');
        if (path.endsWith('/maternity/labor-admissions/active')) {
          expect(request.url.queryParameters, {'limit': '50'});
          boardReads++;
          return boardResponse();
        }
        if (path.endsWith('/maternity/labor-admissions/7')) {
          chartReads++;
          return _ok({'id': 7, 'status': 'active'});
        }
        expect(path, endsWith('/maternity/partograph/labor/7'));
        return _ok(const []);
      }),
    );
    router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (_, _) => const MaternityScreen()),
        GoRoute(
          path: '/maternity/labor/7/chart',
          builder: (_, _) => const PartographViewScreen(laborAdmissionId: 7),
        ),
        GoRoute(
          path: '/maternity/partograph/7',
          builder: (_, _) => const PartographEntryScreen(laborAdmissionId: 7),
        ),
        GoRoute(
          path: '/away',
          builder: (_, _) => const Scaffold(body: Text('Outside maternity')),
        ),
      ],
    );
  });

  tearDown(() {
    router.dispose();
    VHHttpClient.resetClientForTesting();
  });

  testWidgets('nested entry refreshes chart and board after returning', (
    tester,
  ) async {
    await openBoard(tester);
    await openChart(tester);
    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();
    await saveEntry(tester);
    expect(chartReads, 2);
    expect(boardReads, 1);

    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();

    expect(boardReads, 2);
    expect(find.text('5 cm'), findsOneWidget);
    expect(find.text('4 cm'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('return from chart refreshes even without a route result', (
    tester,
  ) async {
    await openBoard(tester);
    await openChart(tester);
    router.pop();
    await tester.pumpAndSettle();

    expect(boardReads, 2);
    expect(writes, isEmpty);
    expect(find.text('4 cm'), findsOneWidget);
  });

  testWidgets(
    'direct entry still refreshes the board after a successful save',
    (tester) async {
      await openBoard(tester);
      await tester.tap(find.text(strings.maternityActionNewEntry));
      await tester.pumpAndSettle();
      await saveEntry(tester);

      expect(boardReads, 2);
      expect(chartReads, 0);
      expect(find.text('5 cm'), findsOneWidget);
    },
  );

  testWidgets('cancelled direct entry does not write or refresh', (
    tester,
  ) async {
    await openBoard(tester);
    await tester.tap(find.text(strings.maternityActionNewEntry));
    await tester.pumpAndSettle();
    router.pop();
    await tester.pumpAndSettle();

    expect(boardReads, 1);
    expect(writes, isEmpty);
    expect(find.text('4 cm'), findsOneWidget);
  });

  testWidgets('failed return refresh exposes retry rather than stale values', (
    tester,
  ) async {
    await openBoard(tester);
    await openChart(tester);
    boardResponse = () async => http.Response(
      jsonEncode({'success': false, 'message': 'Synthetic refresh rejection'}),
      400,
      headers: {'content-type': 'application/json'},
    );
    router.pop();
    await tester.pumpAndSettle();

    expect(boardReads, 2);
    expect(find.text('Synthetic refresh rejection'), findsOneWidget);
    expect(find.text('4 cm'), findsNothing);
    boardResponse = () async => currentBoard();
    await tester.tap(find.text(strings.maternityRetry));
    await tester.pumpAndSettle();
    expect(boardReads, 3);
    expect(find.text('4 cm'), findsOneWidget);
  });

  testWidgets(
    'leaving maternity with chart open does not refresh disposed board',
    (tester) async {
      await openBoard(tester);
      await openChart(tester);
      router.go('/away');
      await tester.pumpAndSettle();

      expect(find.text('Outside maternity'), findsOneWidget);
      expect(boardReads, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('pending return refresh tolerates board disposal', (
    tester,
  ) async {
    await openBoard(tester);
    await openChart(tester);
    final pending = Completer<http.Response>();
    boardResponse = () => pending.future;
    router.pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(boardReads, 2);
    router.go('/away');
    await tester.pumpAndSettle();
    pending.complete(currentBoard());
    await tester.pumpAndSettle();

    expect(find.text('Outside maternity'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
