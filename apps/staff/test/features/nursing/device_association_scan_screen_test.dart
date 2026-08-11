import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
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

  testWidgets('manual device selection exposes an association action', (
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
    await tester.pump();

    expect(associatedPatient, 'patient-42');
    expect(associatedDevice, 'MON-1');
    expect(find.text('Bedside Monitor'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
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
