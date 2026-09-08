import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/maternity/screens/partograph_entry_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

final _descent = find.byType(DropdownButtonFormField<int>);

http.Response _response({bool success = true}) => http.Response(
  jsonEncode({
    'success': success,
    if (success) 'data': {'on_alert_line': false, 'on_action_line': false},
    if (!success) 'message': 'Synthetic rejection',
  }),
  success ? 201 : 400,
  headers: {'content-type': 'application/json'},
);

Future<void> _openEntry(
  WidgetTester tester, {
  Locale locale = const Locale('en'),
}) async {
  await tester.pumpWidget(
    MaterialApp(
      locale: locale,
      supportedLocales: AppStrings.supportedLocales,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      initialRoute: '/entry',
      routes: {
        '/': (_) => const Scaffold(body: Text('Returned from entry')),
        '/entry': (_) => const PartographEntryScreen(laborAdmissionId: 7),
      },
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _chooseDescent(
  WidgetTester tester,
  int? value, {
  Locale locale = const Locale('en'),
}) async {
  await tester.scrollUntilVisible(
    _descent,
    -500,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.tap(_descent);
  await tester.pumpAndSettle();
  final label = value?.toString() ?? AppStrings.forLocale(locale).labelOptional;
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

Future<void> _submit(WidgetTester tester) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pumpAndSettle();
  await tester.scrollUntilVisible(
    find.byType(FilledButton),
    500,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
  expect(find.byType(FilledButton).hitTestable(), findsOneWidget);
  await tester.tap(find.byType(FilledButton));
  await tester.pumpAndSettle();
}

void main() {
  late List<Map<String, dynamic>> payloads;
  late http.Response Function() respond;

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    payloads = [];
    respond = _response;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, endsWith('/maternity/partograph'));
        payloads.add(jsonDecode(request.body) as Map<String, dynamic>);
        return respond();
      }),
    );
  });

  tearDown(VHHttpClient.resetClientForTesting);

  testWidgets('descent offers only unset and integers zero through five', (
    tester,
  ) async {
    await _openEntry(tester);

    final dropdown = tester.widget<DropdownButton<int>>(
      find.descendant(of: _descent, matching: find.byType(DropdownButton<int>)),
    );
    expect(dropdown.items!.map((item) => item.value), [null, 0, 1, 2, 3, 4, 5]);
    expect(dropdown.value, isNull);
    expect(
      find.widgetWithText(
        TextFormField,
        AppStrings.forLocale(const Locale('en')).partographDescent,
      ),
      findsNothing,
    );
    expect(payloads, isEmpty);
  });

  testWidgets('unset descent stays omitted from a successful entry', (
    tester,
  ) async {
    await _openEntry(tester);
    await _submit(tester);

    expect(payloads, hasLength(1));
    expect(payloads.single, {'labor_admission_id': 7});
    expect(find.text('Returned from entry'), findsOneWidget);
  });

  for (final value in [0, 1, 2, 3, 4, 5]) {
    testWidgets('selected descent $value is submitted as an integer', (
      tester,
    ) async {
      await _openEntry(tester);
      await _chooseDescent(tester, value);
      await _submit(tester);

      expect(payloads, hasLength(1));
      expect(payloads.single, {
        'labor_admission_id': 7,
        'descent_fifths_above_brim': value,
      });
      expect(payloads.single['descent_fifths_above_brim'], isA<int>());
      expect(find.text('Returned from entry'), findsOneWidget);
    });
  }

  testWidgets('clearing a selected zero omits descent again', (tester) async {
    await _openEntry(tester);
    await _chooseDescent(tester, 0);
    await _chooseDescent(tester, null);
    await _submit(tester);

    expect(payloads, hasLength(1));
    expect(payloads.single, {'labor_admission_id': 7});
  });

  testWidgets('descent selection preserves other decimal measurements', (
    tester,
  ) async {
    await _openEntry(tester);
    final strings = AppStrings.forLocale(const Locale('en'));
    await tester.enterText(
      find.widgetWithText(TextFormField, strings.partographCervixDilation),
      '4.5',
    );
    await _chooseDescent(tester, 2);
    final temperature = find.widgetWithText(
      TextFormField,
      strings.partographTemperature,
    );
    await tester.scrollUntilVisible(
      temperature,
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.enterText(temperature, '37.4');
    await _submit(tester);

    expect(payloads, hasLength(1));
    expect(payloads.single, {
      'labor_admission_id': 7,
      'descent_fifths_above_brim': 2,
      'cervix_dilation_cm': 4.5,
      'temperature_c': 37.4,
    });
  });

  testWidgets(
    'failed entry retains descent and retry uses the corrected value',
    (tester) async {
      respond = () => _response(success: payloads.length > 1);
      await _openEntry(tester);
      await _chooseDescent(tester, 5);
      await _submit(tester);

      expect(payloads, hasLength(1));
      expect(payloads.single['descent_fifths_above_brim'], 5);
      expect(find.text('Synthetic rejection'), findsOneWidget);
      await tester.scrollUntilVisible(
        _descent,
        -500,
        scrollable: find.byType(Scrollable).first,
      );
      expect(tester.state<FormFieldState<int>>(_descent).value, 5);
      await _chooseDescent(tester, 0);
      await _submit(tester);

      expect(payloads, hasLength(2));
      expect(payloads.last['descent_fifths_above_brim'], 0);
      expect(find.text('Returned from entry'), findsOneWidget);
    },
  );

  for (final code in ['en', 'hi', 'ta', 'te', 'ml']) {
    final locale = Locale(code);
    testWidgets('descent reuses existing ${locale.languageCode} labels', (
      tester,
    ) async {
      expect(AppStrings.supportedLocales, contains(locale));
      await _openEntry(tester, locale: locale);
      final strings = AppStrings.forLocale(locale);
      expect(find.text(strings.partographDescent), findsOneWidget);
      final dropdown = tester.widget<DropdownButton<int>>(
        find.descendant(
          of: _descent,
          matching: find.byType(DropdownButton<int>),
        ),
      );
      expect(dropdown.items!.map((item) => item.value), [
        null,
        0,
        1,
        2,
        3,
        4,
        5,
      ]);
      expect(dropdown.items!.map((item) => (item.child as Text).data), [
        strings.labelOptional,
        '0',
        '1',
        '2',
        '3',
        '4',
        '5',
      ]);
      await _chooseDescent(tester, 1, locale: locale);
      await _chooseDescent(tester, null, locale: locale);
      await _submit(tester);
      expect(payloads.single, {'labor_admission_id': 7});
    });
  }
}
