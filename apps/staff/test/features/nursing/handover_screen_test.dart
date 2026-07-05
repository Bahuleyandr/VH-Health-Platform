import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/features/nursing/screens/handover_screen.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{'staff_phone': '9999999999'};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(
          call.arguments as Map? ?? const {},
        );
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

  tearDown(() async {
    VHHttpClient.resetClientForTesting();
    await RealtimeClient.instance.disconnect();
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets('loads recent handovers and submits once while pending', (
    tester,
  ) async {
    final pendingSubmit = Completer<http.Response>();
    var submitCalls = 0;
    Map<String, dynamic>? submittedBody;

    VHHttpClient.setClientForTesting(
      MockClient((request) {
        final path = request.url.path;
        if (request.method == 'GET' && path.endsWith('/notifications/my')) {
          return Future.value(
            http.Response(
              jsonEncode({
                'success': true,
                'data': {
                  'notifications': [
                    {
                      'title': 'Shift handover: ICU',
                      'type': 'handover',
                      'body': 'Bed 4 pending labs',
                      'urgency': 'High',
                      'createdAt': '2026-07-05T08:00:00Z',
                    },
                    {
                      'title': 'Cafeteria update',
                      'type': 'announcement',
                      'body': 'Not a clinical handover',
                    },
                  ],
                },
              }),
              200,
              headers: {'content-type': 'application/json'},
            ),
          );
        }

        if (request.method == 'POST' &&
            path.endsWith('/staff/medical/consultations')) {
          submitCalls++;
          submittedBody = jsonDecode(request.body) as Map<String, dynamic>;
          return pendingSubmit.future;
        }

        return Future.value(
          http.Response(
            jsonEncode({
              'success': false,
              'message': 'Unexpected ${request.method} $path',
            }),
            404,
            headers: {'content-type': 'application/json'},
          ),
        );
      }),
    );

    await tester.pumpWidget(const MaterialApp(home: HandoverScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Recent'));
    await tester.pumpAndSettle();

    expect(find.text('Shift handover: ICU'), findsOneWidget);
    expect(find.text('Bed 4 pending labs'), findsOneWidget);
    expect(find.text('Cafeteria update'), findsNothing);

    await tester.tap(find.text('Write'));
    await tester.pumpAndSettle();

    final notesField = find.widgetWithText(TextFormField, 'Handover Notes');
    expect(notesField, findsOneWidget);
    await tester.enterText(notesField, 'Night shift: labs pending.');

    await tester.ensureVisible(find.byType(FilledButton));
    await tester.pump();
    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    await tester.tap(find.byType(FilledButton), warnIfMissed: false);
    await tester.pump();

    expect(submitCalls, 1);
    expect(submittedBody, isNotNull);
    expect(submittedBody!['phone'], '9999999999');
    expect(submittedBody!['consultationType'], 'handover-note');
    expect(submittedBody!['notes'], 'Night shift: labs pending.');

    pendingSubmit.complete(
      http.Response(
        jsonEncode({
          'success': true,
          'data': {'id': 'handover-1'},
        }),
        200,
        headers: {'content-type': 'application/json'},
      ),
    );
    await tester.pumpAndSettle();
  });
}
