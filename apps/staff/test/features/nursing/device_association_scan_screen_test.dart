import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/nursing/screens/device_association_scan_screen.dart';

import '../../helpers/plugin_channel_mocks.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    mockMobileScanner();
  });

  tearDown(() async {
    clearAllPluginMocks();
    await RealtimeClient.instance.disconnect();
  });

  Future<void> pumpScreen(
    WidgetTester tester, {
    required Future<List<Map<String, dynamic>>> Function() loadDevices,
    required Future<List<Map<String, dynamic>>> Function({
      required String patientUid,
    })
    loadAssociations,
    required Future<Map<String, dynamic>> Function({
      required String patientUid,
      required String deviceCode,
    })
    associateDevice,
    required Future<Map<String, dynamic>> Function(int id)
    disconnectAssociation,
    Future<Map<String, dynamic>?> Function(String patientUid)?
    loadPatientIdentity,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(900, 1200);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (_, _) => DeviceAssociationScanScreen(
            initialPatientUid: 'patient-42',
            patientName: 'Untrusted route name',
            loadPatientIdentity:
                loadPatientIdentity ??
                (_) async => {
                  'uid': 'patient-42',
                  'name': 'Authoritative Patient',
                  'hospital_number': 'VH-000042',
                },
            loadDevices: loadDevices,
            loadAssociations: loadAssociations,
            associateDevice: associateDevice,
            disconnectAssociation: disconnectAssociation,
          ),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ThemeProvider(),
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  Future<void> selectDevice(WidgetTester tester) async {
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Bedside Monitor - MON-1').last);
    await tester.pump();
  }

  testWidgets('manual device selection requires review before association', (
    tester,
  ) async {
    String? associatedPatient;
    String? associatedDevice;
    var associationLoads = 0;

    await pumpScreen(
      tester,
      loadDevices: () async => [
        {'device_code': 'MON-1', 'display_name': 'Bedside Monitor'},
      ],
      loadAssociations: ({required patientUid}) async {
        associationLoads++;
        if (associationLoads == 1) return const [];
        return [
          {
            'id': 7,
            'device_code': 'MON-1',
            'device_name': 'Bedside Monitor',
            'channel': 'vitals',
          },
        ];
      },
      associateDevice: ({required patientUid, required deviceCode}) async {
        associatedPatient = patientUid;
        associatedDevice = deviceCode;
        return const {};
      },
      disconnectAssociation: (_) async => const {},
    );

    await selectDevice(tester);
    final action = find.widgetWithText(FilledButton, 'Associate device');
    expect(action, findsOneWidget);

    await tester.tap(action);
    await tester.pump();

    expect(associatedPatient, isNull);
    expect(associatedDevice, isNull);
    final confirm = find.widgetWithText(FilledButton, 'Confirm');
    expect(confirm, findsOneWidget);
    expect(find.text('Authoritative Patient'), findsOneWidget);
    expect(find.textContaining('VH-000042'), findsOneWidget);
    expect(find.text('Untrusted route name'), findsNothing);

    await tester.tap(confirm);
    await tester.pump();
    await tester.pump();

    expect(associatedPatient, 'patient-42');
    expect(associatedDevice, 'MON-1');
    expect(find.text('Bedside Monitor'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('confirmation is disabled until patient identity is verified', (
    tester,
  ) async {
    final identity = Completer<Map<String, dynamic>?>();
    var associationCalls = 0;

    await pumpScreen(
      tester,
      loadDevices: () async => [
        {'device_code': 'MON-1', 'display_name': 'Bedside Monitor'},
      ],
      loadAssociations: ({required patientUid}) async => const [],
      loadPatientIdentity: (_) => identity.future,
      associateDevice: ({required patientUid, required deviceCode}) async {
        associationCalls++;
        return const {};
      },
      disconnectAssociation: (_) async => const {},
    );

    await selectDevice(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Associate device'));
    await tester.pump();

    final pendingConfirm = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Confirm'),
    );
    expect(pendingConfirm.onPressed, isNull);

    identity.complete({
      'uid': 'patient-42',
      'name': 'Verified Patient',
      'hospital_number': 'VH-000042',
    });
    await tester.pump();

    final verifiedConfirm = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Confirm'),
    );
    expect(verifiedConfirm.onPressed, isNotNull);
    expect(find.text('Verified Patient'), findsOneWidget);
    expect(associationCalls, 0);
  });

  testWidgets(
    'identity lookup failure keeps confirmation closed until a verified retry',
    (tester) async {
      var associationCalls = 0;
      var identityCalls = 0;

      await pumpScreen(
        tester,
        loadDevices: () async => [
          {'device_code': 'MON-1', 'display_name': 'Bedside Monitor'},
        ],
        loadAssociations: ({required patientUid}) async => const [],
        loadPatientIdentity: (_) async {
          identityCalls++;
          if (identityCalls == 1) return null;
          return {
            'uid': 'patient-42',
            'name': 'Recovered Patient',
            'hospital_number': 'VH-000042',
          };
        },
        associateDevice: ({required patientUid, required deviceCode}) async {
          associationCalls++;
          return const {};
        },
        disconnectAssociation: (_) async => const {},
      );

      await selectDevice(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Associate device'));
      await tester.pump();

      final confirm = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Confirm'),
      );
      expect(confirm.onPressed, isNull);
      expect(find.text('Untrusted route name'), findsNothing);
      expect(associationCalls, 0);

      await tester.tap(find.widgetWithText(TextButton, 'Retry'));
      await tester.pump();

      final recoveredConfirm = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Confirm'),
      );
      expect(recoveredConfirm.onPressed, isNotNull);
      expect(find.text('Recovered Patient'), findsOneWidget);
      expect(identityCalls, 2);
      expect(associationCalls, 0);
    },
  );

  testWidgets('scanned device code requires review before association', (
    tester,
  ) async {
    var associationCalls = 0;

    await pumpScreen(
      tester,
      loadDevices: () async => const [],
      loadAssociations: ({required patientUid}) async => const [],
      associateDevice: ({required patientUid, required deviceCode}) async {
        associationCalls++;
        expect(patientUid, 'patient-42');
        expect(deviceCode, 'MON-SCANNED');
        return const {};
      },
      disconnectAssociation: (_) async => const {},
    );

    final scanner = tester.widget<MobileScanner>(find.byType(MobileScanner));
    scanner.onDetect!(
      const BarcodeCapture(barcodes: [Barcode(rawValue: 'MON-SCANNED')]),
    );
    await tester.pump();

    expect(associationCalls, 0);
    expect(find.widgetWithText(FilledButton, 'Confirm'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 701));

    expect(associationCalls, 1);
  });

  testWidgets(
    'late associate failure is ignored after the screen is disposed',
    (tester) async {
      final completion = Completer<Map<String, dynamic>>();

      await pumpScreen(
        tester,
        loadDevices: () async => [
          {'device_code': 'MON-1', 'display_name': 'Bedside Monitor'},
        ],
        loadAssociations: ({required patientUid}) async => const [],
        associateDevice: ({required patientUid, required deviceCode}) =>
            completion.future,
        disconnectAssociation: (_) async => const {},
      );

      await selectDevice(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Associate device'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
      await tester.pump();
      await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));

      completion.completeError(StateError('late associate failure'));
      await tester.pump();

      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'late disconnect failure is ignored after the screen is disposed',
    (tester) async {
      final completion = Completer<Map<String, dynamic>>();

      await pumpScreen(
        tester,
        loadDevices: () async => const [],
        loadAssociations: ({required patientUid}) async => [
          {
            'id': 7,
            'device_code': 'MON-1',
            'device_name': 'Bedside Monitor',
            'channel': 'vitals',
          },
        ],
        associateDevice: ({required patientUid, required deviceCode}) async =>
            const {},
        disconnectAssociation: (_) => completion.future,
      );

      await tester.tap(find.byTooltip('Disconnect device'));
      await tester.pump();
      await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));

      completion.completeError(StateError('late disconnect failure'));
      await tester.pump();

      expect(tester.takeException(), isNull);
    },
  );
}
