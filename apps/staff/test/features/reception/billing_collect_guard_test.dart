import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/reception/widgets/billing_collect_button.dart';
import 'package:vhhealth_staff/features/reception/widgets/billing_payment_dialog.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{'jwt': 'test-jwt'};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key'] as String] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_installSecureStorageFake);

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
  });

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

  testWidgets('billing payment dialog submits once from Enter while pending', (
    tester,
  ) async {
    final pending = Completer<http.Response>();
    var paymentPosts = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) {
        if (request.method == 'POST' &&
            request.url.path.endsWith('/billing/v2/payments')) {
          paymentPosts++;
          return pending.future;
        }
        return Future.value(http.Response(jsonEncode({'success': false}), 404));
      }),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => FilledButton(
              onPressed: () => showBillingPaymentDialog(
                context: context,
                invoice: const {
                  'id': 7,
                  'invoice_number': 'INV-7',
                  'status': 'ISSUED',
                  'total_amount': 100,
                  'amount_paid': 0,
                },
              ),
              child: const Text('Open collect'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open collect'));
    await tester.pumpAndSettle();
    final referenceField = find.byWidgetPredicate(
      (widget) =>
          widget is TextField &&
          widget.decoration?.labelText == 'Transaction reference',
    );
    final notesField = find.byWidgetPredicate(
      (widget) =>
          widget is TextField && widget.decoration?.labelText == 'Notes',
    );
    expect(referenceField, findsOneWidget);
    expect(notesField, findsOneWidget);

    tester.widget<TextField>(referenceField).controller!.text = 'UPI-123';
    final notesWidget = tester.widget<TextField>(notesField);
    notesWidget.onChanged!('Collected at counter\n');
    await tester.pump();
    notesWidget.onChanged!('Collected at counter\n');
    await tester.pump();

    expect(paymentPosts, 1);

    pending.complete(
      http.Response(
        jsonEncode({
          'success': true,
          'data': {'payment_id': 42},
        }),
        200,
        headers: {'content-type': 'application/json'},
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Collect Payment'), findsNothing);
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
