import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/features/appointments/widgets/appointments_list_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_installSecureStorageFake);

  tearDown(() {
    VHHttpClient.resetClientForTesting();
  });

  testWidgets('shows localized empty state with booking action', (
    tester,
  ) async {
    var bookTapped = false;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/appointments/patient/patient-1'));
        return http.Response('{"data":{"appointments":[]}}', 200);
      }),
    );

    await tester.pumpWidget(
      _Harness(child: AppointmentsListTab(onBookOne: () => bookTapped = true)),
    );
    await tester.pumpAndSettle();

    expect(find.text('No appointments yet'), findsOneWidget);
    expect(find.textContaining('Book a visit'), findsOneWidget);

    await tester.tap(find.text('Book one now'));
    await tester.pump();
    expect(bookTapped, isTrue);
  });

  testWidgets('shows retryable localized error state when load fails', (
    tester,
  ) async {
    var calls = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        calls += 1;
        return http.Response('{"message":"Backend unavailable"}', 400);
      }),
    );

    await tester.pumpWidget(
      _Harness(child: AppointmentsListTab(onBookOne: () {})),
    );
    await tester.pumpAndSettle();

    expect(
      find.text('Something went wrong. Please try again.'),
      findsOneWidget,
    );
    expect(find.text('Backend unavailable'), findsOneWidget);

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(calls, 2);
  });

  testWidgets('shows reschedule action for an upcoming scheduled appointment', (
    tester,
  ) async {
    final future = DateTime.now().add(const Duration(days: 7));
    final date =
        '${future.year.toString().padLeft(4, '0')}-'
        '${future.month.toString().padLeft(2, '0')}-'
        '${future.day.toString().padLeft(2, '0')}';
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/appointments/patient/patient-1'));
        return http.Response(
          '{"data":{"appointments":[{"id":101,"doctor_name":"Dr. Meera","department":"Cardiology","appointment_date":"$date","appointment_time":"10:30","status":"SCHEDULED","reason":"Follow-up"}]}}',
          200,
        );
      }),
    );

    await tester.pumpWidget(
      _Harness(child: AppointmentsListTab(onBookOne: () {})),
    );
    await tester.pumpAndSettle();

    expect(find.text('Dr. Meera'), findsOneWidget);
    expect(find.text('Reschedule'), findsOneWidget);

    await tester.tap(find.text('Reschedule'));
    await tester.pumpAndSettle();
    expect(find.text('Choose a new slot'), findsOneWidget);
  });
}

class _Harness extends StatelessWidget {
  const _Harness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => WebSocketProvider(),
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(body: child),
      ),
    );
  }
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{'user_id': 'patient-1'};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
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
