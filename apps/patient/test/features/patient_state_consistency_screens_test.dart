import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/features/family/screens/family_screen.dart';
import 'package:vhhealth/features/medications/screens/medication_reminders_screen.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_form_tab.dart';
import 'package:vhhealth/features/portal/screens/bills_screen.dart';
import 'package:vhhealth/features/portal/screens/tpa_claims_screen.dart';
import 'package:vhhealth/features/vitals/widgets/vitals_history_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_installSecureStorageFake);

  tearDown(() {
    VHHttpClient.resetClientForTesting();
  });

  testWidgets('bills screen renders shared localized empty state', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/portal/bills'));
        return http.Response('{"data":[]}', 200);
      }),
    );

    await tester.pumpWidget(const _Harness(child: BillsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('No bills yet'), findsOneWidget);
    expect(find.textContaining('Bills issued by the hospital'), findsOneWidget);
    expect(find.text('Refresh'), findsOneWidget);
  });

  testWidgets('TPA claims screen renders shared localized empty state', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/portal/tpa/claims'));
        return http.Response('{"data":[]}', 200);
      }),
    );

    await tester.pumpWidget(const _Harness(child: TpaClaimsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('No insurance claims yet'), findsOneWidget);
    expect(
      find.textContaining('Insurance and cashless claims'),
      findsOneWidget,
    );
    expect(find.text('Refresh'), findsOneWidget);
  });

  testWidgets('family screen renders add-member empty action', (tester) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/users/family-members'));
        return http.Response('{"data":[]}', 200);
      }),
    );

    await tester.pumpWidget(const _Harness(child: FamilyScreen()));
    await tester.pumpAndSettle();

    expect(find.text('No family members yet'), findsOneWidget);
    expect(find.text('Add Family Member'), findsWidgets);
  });

  testWidgets('medication reminders screen renders retryable error state', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/reminders/medication'));
        return http.Response('{"message":"Reminders unavailable"}', 400);
      }),
    );

    await tester.pumpWidget(const _Harness(child: MedicationRemindersScreen()));
    await tester.pumpAndSettle();

    expect(
      find.text('Something went wrong. Please try again.'),
      findsOneWidget,
    );
    expect(find.text('Reminders unavailable'), findsOneWidget);
    expect(find.text('Retry reminders'), findsOneWidget);
  });

  testWidgets('vitals history tab renders shared empty state', (tester) async {
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/health/patient/5551234567/vitals'));
        return http.Response('{"data":[]}', 200);
      }),
    );

    await tester.pumpWidget(
      const _Harness(child: VitalsHistoryTab(phone: '5551234567')),
    );
    await tester.pumpAndSettle();

    expect(find.text('No vitals recorded yet'), findsOneWidget);
    expect(find.textContaining('Log your vitals'), findsOneWidget);
    expect(find.text('Refresh'), findsOneWidget);
  });

  testWidgets('pharmacy order form uses localized submit copy', (tester) async {
    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      _Harness(
        child: Scaffold(
          body: OrderFormTab(phone: '5551234567', onOrderPlaced: () {}),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Place Order'), findsOneWidget);
  });
}

class _Harness extends StatelessWidget {
  const _Harness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    );
  }
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{};

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
