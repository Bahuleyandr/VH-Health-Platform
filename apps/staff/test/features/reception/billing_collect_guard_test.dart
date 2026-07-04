import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/reception/widgets/billing_collect_button.dart';

void main() {
  testWidgets('billing collect button fires once while pending', (
    tester,
  ) async {
    final pending = Completer<void>();
    var collectCalls = 0;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: _BillingCollectHarness(
            pending: pending.future,
            onCollect: () => collectCalls++,
          ),
        ),
      ),
    );

    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    await tester.tap(find.byType(FilledButton), warnIfMissed: false);
    await tester.pump();

    expect(collectCalls, 1);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    pending.complete();
    await tester.pumpAndSettle();
  });
}

class _BillingCollectHarness extends StatefulWidget {
  final Future<void> pending;
  final VoidCallback onCollect;

  const _BillingCollectHarness({
    required this.pending,
    required this.onCollect,
  });

  @override
  State<_BillingCollectHarness> createState() => _BillingCollectHarnessState();
}

class _BillingCollectHarnessState extends State<_BillingCollectHarness> {
  bool _busy = false;

  void _collect() {
    if (_busy) return;
    setState(() => _busy = true);
    widget.onCollect();
    widget.pending.whenComplete(() {
      if (mounted) setState(() => _busy = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    return BillingCollectButton(busy: _busy, onPressed: _collect);
  }
}
