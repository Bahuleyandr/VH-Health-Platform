import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/appointments/widgets/appointment_card.dart';
import 'package:vhhealth/features/portal/screens/bills_screen.dart';
import 'package:vhhealth/features/portal/screens/tpa_claims_screen.dart';
import 'package:vhhealth/features/vitals/widgets/vitals_form_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_installSecureStorageFake);

  tearDown(() {
    VHHttpClient.resetClientForTesting();
  });

  testWidgets('dashboard dial entries announce feature names', (tester) async {
    await _withSemantics(tester, () async {
      await tester.pumpWidget(
        _Harness(
          child: CircularFeatureDial(
            size: 420,
            features: [
              FeatureIconData(
                icon: Icons.calendar_month,
                label: 'Appointments',
                color: Colors.blue,
                onTap: (_) {},
              ),
              FeatureIconData(
                icon: Icons.local_pharmacy,
                label: 'Pharmacy',
                color: Colors.green,
                onTap: (_) {},
              ),
            ],
          ),
        ),
      );
      await tester.pump();

      final appointments = find.semantics
          .byLabel('Appointments')
          .evaluate()
          .single;
      final pharmacy = find.semantics.byLabel('Pharmacy').evaluate().single;

      expect(appointments.flagsCollection.isButton, isTrue);
      expect(pharmacy.flagsCollection.isButton, isTrue);
    });
  });

  testWidgets('TPA claim status chip exposes the status text', (tester) async {
    await _withSemantics(tester, () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.url.path, endsWith('/portal/tpa/claims'));
          return http.Response(
            '{"data":[{"id":17,"claim_number":"TPA-17","status":"APPROVED","claim_type":"cashless","claimed_amount":10000,"approved_amount":9000,"paid_amount":8500}]}',
            200,
          );
        }),
      );

      await tester.pumpWidget(const _Harness(child: TpaClaimsScreen()));
      await tester.pumpAndSettle();

      expect(find.semantics.byLabel('APPROVED'), findsOne);
    });
  });

  testWidgets('bill status badge exposes the status text', (tester) async {
    await _withSemantics(tester, () async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          expect(request.url.path, endsWith('/portal/bills'));
          return http.Response(
            '{"data":[{"id":42,"invoice_number":"INV-42","status":"PAID","invoice_type":"OP","total_amount":1200,"amount_paid":1200,"amount_due":0,"issued_at":"2026-07-04T09:00:00Z"}]}',
            200,
          );
        }),
      );

      await tester.pumpWidget(const _Harness(child: BillsScreen()));
      await tester.pumpAndSettle();

      expect(find.semantics.byLabel('PAID'), findsOne);
    });
  });

  testWidgets('appointment status badge exposes the status text', (
    tester,
  ) async {
    await _withSemantics(tester, () async {
      await tester.pumpWidget(
        _Harness(
          child: AppointmentCard(
            appt: const AppointmentInfo(
              id: 1,
              doctorName: 'Dr Rao',
              department: 'Cardiology',
              date: '2099-01-01',
              time: '10:00',
              status: 'scheduled',
            ),
            onViewPrescription: (_) {},
            onCancel: (_) {},
          ),
        ),
      );
      await tester.pump();

      expect(find.semantics.byLabel('Scheduled'), findsOne);
    });
  });

  testWidgets('vitals numeric inputs expose unit-aware semantic labels', (
    tester,
  ) async {
    await _withSemantics(tester, () async {
      await tester.pumpWidget(
        _Harness(child: VitalsFormTab(onSubmitted: () {})),
      );
      await tester.pump();

      for (final label in <String>[
        'Systolic, mmHg',
        'Diastolic, mmHg',
        'Heart Rate, bpm',
        'Temperature, °F',
        'Blood Sugar, mg/dL',
        'Weight, kg',
        'SpO2, %',
      ]) {
        final node = find.semantics.byLabel(label).evaluate().single;
        expect(node.flagsCollection.isTextField, isTrue);
      }
    });
  });
}

Future<void> _withSemantics(
  WidgetTester tester,
  Future<void> Function() body,
) async {
  final semantics = tester.ensureSemantics();
  try {
    await body();
  } finally {
    semantics.dispose();
  }
}

class _Harness extends StatelessWidget {
  const _Harness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: child),
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
