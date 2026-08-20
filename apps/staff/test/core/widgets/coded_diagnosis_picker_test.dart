// WP2 — settings-driven CodedDiagnosisPicker.
//
// Pins the dark-ship contract: with default tenant terminology settings the
// picker searches ICD-11 explicitly (byte-identical to the old hardcoded
// behavior, including when the settings fetch fails), while a tenant with a
// different preferred_diagnosis_system or snomed_pickers_enabled=true gets
// the settings-driven behavior (explicit preferred system, or multi-system
// search with per-suggestion system badges).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/widgets/coded_diagnosis_picker.dart';

class _SearchCall {
  final String? system;
  final String query;
  _SearchCall(this.system, this.query);
}

void main() {
  late TextEditingController controller;

  setUp(() {
    controller = TextEditingController();
  });

  tearDown(() {
    controller.dispose();
  });

  Widget host({
    required Future<Map<String, dynamic>> Function() settings,
    required List<_SearchCall> calls,
    List<Map<String, dynamic>> concepts = const [],
    ValueChanged<Map<String, dynamic>?>? onCodingChanged,
    Map<String, dynamic>? selectedCoding,
  }) {
    return MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: CodedDiagnosisPicker(
            controller: controller,
            label: 'Diagnosis',
            hint: 'Type a diagnosis',
            selectedCoding: selectedCoding,
            onCodingChanged: onCodingChanged ?? (_) {},
            loadTerminologySettings: settings,
            searchTerminology:
                ({
                  String? system,
                  required String query,
                  int limit = 20,
                }) async {
                  calls.add(_SearchCall(system, query));
                  return {'concepts': concepts};
                },
          ),
        ),
      ),
    );
  }

  Future<void> typeAndSettle(WidgetTester tester, String text) async {
    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.enterText(find.byType(TextField), text);
    // Debounce is 350ms.
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
  }

  testWidgets('default settings keep the hardcoded ICD-11 search', (
    tester,
  ) async {
    final calls = <_SearchCall>[];
    await tester.pumpWidget(
      host(
        settings: () async => {
          'preferred_diagnosis_system': 'ICD11',
          'enabled_systems': ['ICD10', 'ICD11'],
          'snomed_pickers_enabled': false,
        },
        calls: calls,
        concepts: [
          {'system_key': 'ICD11', 'code': 'BA41', 'display': 'Acute MI'},
        ],
      ),
    );
    await tester.pump();

    await typeAndSettle(tester, 'myocard');

    expect(calls, hasLength(1));
    expect(calls.single.system, 'ICD11');
    expect(calls.single.query, 'myocard');
    expect(find.text('Acute MI'), findsOneWidget);
    expect(find.text('ICD-11 BA41'), findsOneWidget);
  });

  testWidgets('settings failure falls back to the ICD-11 default', (
    tester,
  ) async {
    final calls = <_SearchCall>[];
    await tester.pumpWidget(
      host(
        settings: () async => throw Exception('settings endpoint down'),
        calls: calls,
      ),
    );
    await tester.pump();

    await typeAndSettle(tester, 'fever');

    expect(calls, hasLength(1));
    expect(calls.single.system, 'ICD11');
  });

  testWidgets('tenant preferred_diagnosis_system drives the search system', (
    tester,
  ) async {
    final calls = <_SearchCall>[];
    Map<String, dynamic>? picked;
    await tester.pumpWidget(
      host(
        settings: () async => {
          'preferred_diagnosis_system': 'ICD10',
          'snomed_pickers_enabled': false,
        },
        calls: calls,
        concepts: [
          {'system_key': 'ICD10', 'code': 'I21.9', 'display': 'Acute MI'},
        ],
        onCodingChanged: (coding) => picked = coding,
      ),
    );
    await tester.pump();

    await typeAndSettle(tester, 'myocard');

    expect(calls.single.system, 'ICD10');
    expect(find.text('ICD-10 I21.9'), findsOneWidget);

    await tester.tap(find.text('Acute MI'));
    await tester.pump();
    expect(picked, isNotNull);
    expect(picked!['system_key'], 'ICD10');
    expect(picked!['code'], 'I21.9');
  });

  testWidgets(
    'snomed_pickers_enabled searches without a system and badges each '
    'suggestion with its own system',
    (tester) async {
      final calls = <_SearchCall>[];
      Map<String, dynamic>? picked;
      await tester.pumpWidget(
        host(
          settings: () async => {
            'preferred_diagnosis_system': 'ICD11',
            'snomed_pickers_enabled': true,
          },
          calls: calls,
          concepts: [
            {
              'system_key': 'SNOMED_CT',
              'code': '22298006',
              'display': 'Myocardial infarction',
            },
            {'system_key': 'ICD11', 'code': 'BA41', 'display': 'Acute MI'},
          ],
          onCodingChanged: (coding) => picked = coding,
        ),
      );
      await tester.pump();

      await typeAndSettle(tester, 'myocard');

      // Settings-driven multi-system search: no explicit system param.
      expect(calls, hasLength(1));
      expect(calls.single.system, isNull);
      expect(find.text('SNOMED CT 22298006'), findsOneWidget);
      expect(find.text('ICD-11 BA41'), findsOneWidget);

      await tester.tap(find.text('Myocardial infarction'));
      await tester.pump();
      expect(picked!['system_key'], 'SNOMED_CT');
      expect(picked!['code'], '22298006');
    },
  );
}
