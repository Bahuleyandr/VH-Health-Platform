import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/widgets/debounced_button.dart';

void main() {
  group('DebouncedButton', () {
    testWidgets('renders child text', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DebouncedButton(
              onPressed: () async {},
              child: const Text('Submit'),
            ),
          ),
        ),
      );

      expect(find.text('Submit'), findsOneWidget);
    });

    testWidgets('calls onPressed when tapped', (tester) async {
      int callCount = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DebouncedButton(
              onPressed: () async {
                callCount++;
              },
              child: const Text('Submit'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();

      expect(callCount, 1);
    });

    testWidgets('prevents duplicate taps while busy', (tester) async {
      int callCount = 0;
      final completer = Completer<void>();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DebouncedButton(
              onPressed: () async {
                callCount++;
                await completer.future;
              },
              child: const Text('Submit'),
            ),
          ),
        ),
      );

      // First tap — starts the async operation
      await tester.tap(find.text('Submit'));
      await tester.pump();

      // Second tap — should be ignored because the button is busy
      await tester.tap(find.text('Submit'));
      await tester.pump();

      // Complete the async operation
      completer.complete();
      await tester.pumpAndSettle();

      expect(callCount, 1);
    });

    testWidgets('shows progress indicator while busy', (tester) async {
      final completer = Completer<void>();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DebouncedButton(
              onPressed: () async => completer.future,
              child: const Text('Submit'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Submit'));
      await tester.pump();

      // Should show a loading indicator
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      completer.complete();
      await tester.pumpAndSettle();

      // Loading indicator should be gone
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('is disabled when onPressed is null', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: DebouncedButton(onPressed: null, child: Text('Disabled')),
          ),
        ),
      );

      final button = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(button.onPressed, isNull);
    });

    testWidgets('re-enables after async operation completes', (tester) async {
      int callCount = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DebouncedButton(
              onPressed: () async {
                callCount++;
                await Future.delayed(const Duration(milliseconds: 10));
              },
              child: const Text('Submit'),
            ),
          ),
        ),
      );

      // First tap
      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();
      expect(callCount, 1);

      // Second tap — should work after first completes
      await tester.tap(find.text('Submit'));
      await tester.pumpAndSettle();
      expect(callCount, 2);
    });
  });
}
