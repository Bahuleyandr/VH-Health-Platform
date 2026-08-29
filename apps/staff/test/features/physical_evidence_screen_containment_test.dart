import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:vhhealth_core/config/tenant_config.dart';
import 'package:vhhealth_core/services/auth_service.dart' as core_auth;
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_core/services/mar_offline_cache.dart';
import 'package:vhhealth_core/services/offline_queue.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/bloodbank/screens/transfusion_scan_screen.dart';
import 'package:vhhealth_staff/features/doctor/screens/prescriptions_screen.dart';
import 'package:vhhealth_staff/features/investigations/screens/specimen_scan_screen.dart';
import 'package:vhhealth_staff/features/ipd/screens/drug_chart_screen.dart';
import 'package:vhhealth_staff/features/nursing/screens/mar_scan_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

import '../helpers/plugin_channel_mocks.dart';

const _secureStorageChannel = MethodChannel(
  'plugins.it_nomads.com/flutter_secure_storage',
);
const _connectivityChannel = MethodChannel(
  'dev.fluttercommunity.plus/connectivity',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  final strings = AppStrings.forLocale(const Locale('en'));
  final secureValues = <String, String>{};
  final requests = <String>[];
  var httpCalls = 0;

  setUp(() async {
    sqflite.databaseFactory = databaseFactoryFfi;
    SharedPreferences.setMockInitialValues({});
    secureValues.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_secureStorageChannel, (call) async {
          final args = Map<String, dynamic>.from(
            call.arguments as Map? ?? const {},
          );
          final key = args['key'] as String?;
          switch (call.method) {
            case 'read':
              return key == null ? null : secureValues[key];
            case 'write':
              if (key != null) secureValues[key] = args['value'] as String;
              return null;
            case 'delete':
              if (key != null) secureValues.remove(key);
              return null;
            case 'readAll':
              return Map<String, String>.from(secureValues);
            case 'containsKey':
              return key != null && secureValues.containsKey(key);
            default:
              return null;
          }
        });

    mockMobileScanner();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_connectivityChannel, (call) async {
          if (call.method == 'check') return const <String>['none'];
          return null;
        });
    httpCalls = 0;
    requests.clear();
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        httpCalls++;
        requests.add('${request.method} ${request.url.path}');
        if (request.method == 'GET' &&
            request.url.path.endsWith('/clinical/drug-chart/admission/61')) {
          return http.Response(
            jsonEncode({
              'success': true,
              'data': {
                'admission': {
                  'patient_name': 'Contained Patient',
                  'patient_uid': 'patient-drug-chart',
                  'encounter_id': 'encounter-61',
                },
                'medication_orders': const [],
                'permissions': {'can_prescribe': true, 'can_administer': false},
              },
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        if (request.method == 'GET' &&
            request.url.path.endsWith('/pharmacy-orders/catalog')) {
          return http.Response(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'catalog_id': 41,
                  'name': 'Aspirin',
                  'strength': '75 mg',
                  'form': 'tablet',
                },
              ],
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response(
          jsonEncode({'success': true, 'data': const {}}),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    OfflineQueue.debugDbFileNameOverride =
        'c0a_physical_surface_${DateTime.now().microsecondsSinceEpoch}.db';
    OfflineQueue.registerMetadataResolvers(
      tenantIdResolver: () => TenantConfig.id,
      reconciliationOwnerResolver: (_) =>
          OfflineQueue.fallbackReconciliationRole,
    );
    await core_auth.AuthService.setStaffId('staff-c0a-surface');
    await OfflineQueue.database;
    await ConnectivitySyncService.instance.resetForTesting();
    ConnectivitySyncService.instance.startListening();
    for (var i = 0; i < 5 && ConnectivitySyncService.instance.isOnline; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    await ConnectivitySyncService.instance.refreshCounts();
    expect(ConnectivitySyncService.instance.isOnline, isFalse);
  });

  tearDown(() async {
    ConnectivitySyncService.instance.stopListening();
    await ConnectivitySyncService.instance.resetForTesting();
    await RealtimeClient.instance.disconnect();
    await OfflineQueue.deleteTestDatabase();
    OfflineQueue.debugDbFileNameOverride = null;
    OfflineQueue.resetMetadataResolversForTesting();
    VHHttpClient.resetClientForTesting();
    clearAllPluginMocks();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_secureStorageChannel, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_connectivityChannel, null);
  });

  Future<void> pumpScreen(
    WidgetTester tester,
    Widget screen, {
    Size size = const Size(900, 1200),
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    final router = GoRouter(
      routes: [GoRoute(path: '/', builder: (_, _) => screen)],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ThemeProvider(),
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pump();
  }

  Future<void> scan(WidgetTester tester, String value) async {
    final scanner = tester.widget<MobileScanner>(find.byType(MobileScanner));
    scanner.onDetect!(BarcodeCapture(barcodes: [Barcode(rawValue: value)]));
    await tester.pump(const Duration(milliseconds: 700));
  }

  Future<void> pumpUiTransition(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  Future<void> pumpUntilFound(
    WidgetTester tester,
    Finder finder, {
    int attempts = 40,
  }) async {
    for (var i = 0; i < attempts; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      if (finder.evaluate().isNotEmpty) return;
    }
  }

  testWidgets(
    'prescription production submit retains the form and sends no create POST offline',
    (tester) async {
      await pumpScreen(
        tester,
        const PrescriptionsScreen(
          prefilledAppointment: {
            'id': 51,
            'patient_id': 501,
            'patient_uid': 'patient-prescription',
            'patient_name': 'Contained Patient',
            'doctor_id': 601,
            'doctor_name': 'Contained Doctor',
            'diagnosis': 'Fever',
          },
        ),
        size: const Size(1500, 1100),
      );

      final medicationField = find.widgetWithText(
        TextFormField,
        strings.lookup('s4.lib.prescriptions.type_drug_name'),
      );
      await pumpUntilFound(tester, medicationField);
      expect(medicationField, findsOneWidget);
      await tester.enterText(medicationField, 'Paracetamol 500 mg');

      final submit = find.text(strings.prescriptionsCreate);
      await tester.ensureVisible(submit);
      await pumpUiTransition(tester);
      requests.clear();
      await tester.tap(submit);
      await pumpUiTransition(tester);

      final fallback = strings.offlineClinicalFallbackMessage(
        strings.offlineClinicalFallbackOpdPrescriptionPads,
      );
      expect(find.text(fallback), findsOneWidget);
      expect(
        requests.where(
          (request) =>
              request == 'POST /prescriptions/create' ||
              request.endsWith(' /prescriptions/create'),
        ),
        isEmpty,
      );
      expect(
        tester.widget<TextFormField>(medicationField).controller?.text,
        'Paracetamol 500 mg',
      );

      await tester.tap(find.text(strings.offlineClinicalFallbackKeepOpen));
      await pumpUiTransition(tester);
      expect(
        tester.widget<TextFormField>(medicationField).controller?.text,
        'Paracetamol 500 mg',
      );
      expect(find.text(strings.prescriptionsCreate), findsOneWidget);
    },
  );

  testWidgets(
    'drug-chart production save retains its draft and sends no order POST offline',
    (tester) async {
      await pumpScreen(
        tester,
        const DrugChartScreen(
          admissionId: 61,
          patientName: 'Contained Patient',
        ),
        size: const Size(1800, 1000),
      );

      final addRow = find.text(strings.drugChartAddRow);
      await pumpUntilFound(tester, addRow);
      expect(addRow, findsWidgets);
      await tester.tap(addRow.first);
      await pumpUiTransition(tester);

      final drugField = find.widgetWithText(
        TextField,
        strings.lookup('drug_chart.column.drug'),
      );
      final doseField = find.widgetWithText(
        TextField,
        strings.drugChartColumnDose,
      );
      await tester.enterText(drugField, 'Aspirin');
      await tester.pump(const Duration(milliseconds: 300));
      await pumpUiTransition(tester);
      final catalogSuggestion = find.widgetWithText(ListTile, 'Aspirin');
      expect(catalogSuggestion, findsOneWidget);
      await tester.tap(catalogSuggestion);
      await pumpUiTransition(tester);
      await tester.enterText(doseField, '75 mg');
      final supplyQuantity = find.byKey(
        const Key('drug-chart-supply-quantity'),
      );
      final supplyUnit = find.byKey(const Key('drug-chart-supply-unit'));
      await tester.enterText(supplyQuantity, '14');
      await tester.tap(supplyUnit);
      await pumpUiTransition(tester);
      await tester.tap(find.text('tablet').last);
      await pumpUiTransition(tester);
      final save = find.widgetWithText(FilledButton, strings.actionSave);
      await tester.ensureVisible(save);
      await pumpUiTransition(tester);
      requests.clear();
      await tester.tap(save);
      await pumpUiTransition(tester);

      final fallback = strings.offlineClinicalFallbackMessage(
        strings.offlineClinicalFallbackInpatientDrugCharts,
      );
      expect(find.text(fallback), findsOneWidget);
      expect(
        requests.where(
          (request) =>
              request == 'POST /emr/orders' || request.endsWith(' /emr/orders'),
        ),
        isEmpty,
      );
      expect(tester.widget<TextField>(drugField).controller?.text, 'Aspirin');
      expect(tester.widget<TextField>(doseField).controller?.text, '75 mg');
      expect(tester.widget<TextField>(supplyQuantity).controller?.text, '14');

      await tester.tap(find.text(strings.offlineClinicalFallbackKeepOpen));
      await pumpUiTransition(tester);
      expect(tester.widget<TextField>(drugField).controller?.text, 'Aspirin');
      expect(tester.widget<TextField>(doseField).controller?.text, '75 mg');
      expect(tester.widget<TextField>(supplyQuantity).controller?.text, '14');
      expect(find.widgetWithText(FilledButton, strings.actionSave), findsOne);
    },
  );

  testWidgets(
    'specimen production scan stays uncollected and performs zero HTTP offline',
    (tester) async {
      await pumpScreen(
        tester,
        const SpecimenScanScreen(
          investigationId: 71,
          expectedPatientUid: 'patient-71',
        ),
      );

      await scan(tester, 'patient-71');
      await scan(tester, 'tube-71');
      await pumpUiTransition(tester);

      final fallback = strings.offlineClinicalFallbackMessage(
        strings.offlineClinicalFallbackLaboratoryRequisitionForms,
      );
      expect(find.text(fallback), findsOneWidget);
      expect(httpCalls, 0);
      expect(
        find.text(strings.lookup('s4.lib.specimen_scan.specimen_collected')),
        findsNothing,
      );
      expect(find.text(strings.offlineRecordedPendingSync), findsNothing);

      await tester.tap(find.text(strings.offlineClinicalFallbackKeepOpen));
      await pumpUiTransition(tester);
      expect(find.text(fallback), findsOneWidget);
      expect(
        find.text(
          strings.lookup('s4.lib.specimen_scan.specimen_not_collected'),
        ),
        findsOneWidget,
      );
      expect(find.byType(MobileScanner), findsNothing);
      expect(httpCalls, 0);
    },
  );

  testWidgets(
    'transfusion production scan stays unverified and performs zero HTTP offline',
    (tester) async {
      await pumpScreen(
        tester,
        const TransfusionScanScreen(
          requestId: 81,
          expectedPatientUid: 'patient-81',
          expectedUnitNumber: 'unit-81',
        ),
      );

      await scan(tester, 'patient-81');
      await scan(tester, 'unit-81');
      await pumpUiTransition(tester);

      final fallback = strings.offlineClinicalFallbackMessage(
        strings.offlineClinicalFallbackBloodBankVerificationSlips,
      );
      expect(find.text(fallback), findsOneWidget);
      expect(httpCalls, 0);
      expect(
        find.text(
          strings.lookup('s4.lib.transfusion_scan.verification_recorded'),
        ),
        findsNothing,
      );
      expect(find.text(strings.offlineRecordedPendingSync), findsNothing);

      await tester.tap(find.text(strings.offlineClinicalFallbackKeepOpen));
      await pumpUiTransition(tester);
      expect(find.text(fallback), findsOneWidget);
      expect(
        find.text(
          strings.lookup('s4.lib.transfusion_scan.verification_not_recorded'),
        ),
        findsOneWidget,
      );
      expect(find.byType(MobileScanner), findsNothing);
      expect(httpCalls, 0);
    },
  );

  testWidgets(
    'MAR production scan retains verification and performs zero HTTP offline',
    (tester) async {
      final scheduledAt = DateTime.now().toUtc();
      await MarOfflineCache.cacheDueDoses('patient-mar', [
        {
          'id': 91,
          'patient_uid': 'patient-mar',
          'medication_name': 'Paracetamol',
          'dose': '500 mg',
          'route': 'oral',
          'scheduled_time': scheduledAt.toIso8601String(),
          'status': 'scheduled',
        },
      ]);
      await pumpScreen(tester, const MarScanScreen(maId: 91));

      await scan(tester, 'patient-mar');
      await scan(tester, 'Paracetamol');
      await pumpUiTransition(tester);

      expect(find.text(strings.offlineClinicalFallbackTitle), findsOneWidget);
      expect(find.text(strings.marScanRecorded), findsNothing);
      expect(find.text(strings.offlineRecordedPendingSync), findsNothing);
      expect(httpCalls, 0);

      await tester.tap(find.text(strings.offlineClinicalFallbackTitle));
      await pumpUiTransition(tester);

      final fallback = strings.offlineClinicalFallbackMessage(
        strings.offlineClinicalFallbackMarSheets,
      );
      expect(find.text(fallback), findsOneWidget);
      expect(find.text(strings.marScanRecorded), findsNothing);
      expect(find.text(strings.offlineRecordedPendingSync), findsNothing);
      expect(httpCalls, 0);

      await tester.tap(find.text(strings.offlineClinicalFallbackKeepOpen));
      await pumpUiTransition(tester);
      expect(find.text(fallback), findsOneWidget);
      expect(find.text(strings.marScanStep3Header), findsOneWidget);
      expect(find.byType(MobileScanner), findsNothing);
      expect(httpCalls, 0);
    },
  );
}
