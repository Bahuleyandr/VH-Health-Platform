import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/doctor/widgets/prescription_submit_button.dart';

void main() {
  testWidgets('prescription submit button fires once while pending', (
    tester,
  ) async {
    final pending = Completer<void>();
    var submitCalls = 0;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: _PrescriptionSubmitHarness(
            pending: pending.future,
            onSubmit: () => submitCalls++,
          ),
        ),
      ),
    );

    await tester.tap(find.byType(ElevatedButton));
    await tester.pump();
    await tester.tap(find.byType(ElevatedButton), warnIfMissed: false);
    await tester.pump();

    expect(submitCalls, 1);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    pending.complete();
    await tester.pumpAndSettle();
  });
}

class _PrescriptionSubmitHarness extends StatefulWidget {
  final Future<void> pending;
  final VoidCallback onSubmit;

  const _PrescriptionSubmitHarness({
    required this.pending,
    required this.onSubmit,
  });

  @override
  State<_PrescriptionSubmitHarness> createState() =>
      _PrescriptionSubmitHarnessState();
}

class _PrescriptionSubmitHarnessState
    extends State<_PrescriptionSubmitHarness> {
  bool _submitting = false;

  void _submit() {
    if (_submitting) return;
    setState(() => _submitting = true);
    widget.onSubmit();
    widget.pending.whenComplete(() {
      if (mounted) setState(() => _submitting = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    return PrescriptionSubmitButton(
      submitting: _submitting,
      locked: false,
      submitLabel: 'Create prescription',
      onSubmit: _submit,
    );
  }
}
