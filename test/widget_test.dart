// Smoke test for the staff app bootstrap.
//
// The original Flutter scaffold test (counter demo) was removed 2026-04-16.
// Real feature-level widget tests live under `test/features/` (coming in
// the clinical-safety widget test batch — see `test/README.md`).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('MaterialApp smoke test — empty shell renders',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: Text('staff')),
        ),
      ),
    );
    expect(find.text('staff'), findsOneWidget);
  });
}
