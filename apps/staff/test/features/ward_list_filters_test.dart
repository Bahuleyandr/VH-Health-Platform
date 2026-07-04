import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/beds/screens/bed_board_screen.dart';
import 'package:vhhealth_staff/features/emr/screens/admission_screen.dart';
import 'package:vhhealth_staff/features/nursing/screens/due_meds_screen.dart';

void _installSecureStorageFake({String role = 'NURSING_STAFF'}) {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{'staff_role': role};

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

http.Response _jsonResponse(Object data) {
  return http.Response(
    jsonEncode(data),
    200,
    headers: {'content-type': 'application/json'},
  );
}

Future<void> _pumpStaffScreen(WidgetTester tester, Widget child) async {
  SharedPreferences.setMockInitialValues({});
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, _) => child),
      GoRoute(path: '/dashboard', builder: (_, _) => const SizedBox.shrink()),
      GoRoute(
        path: '/mar/scan/:id',
        builder: (_, _) => const SizedBox.shrink(),
      ),
      GoRoute(
        path: '/patient-command-board',
        builder: (_, _) => const SizedBox.shrink(),
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
  await tester.pumpAndSettle();
}

Future<void> _chooseDropdownOption(
  WidgetTester tester,
  Key dropdownKey,
  String option,
) async {
  await tester.tap(find.byKey(dropdownKey));
  await tester.pumpAndSettle();
  await tester.tap(find.text(option).last);
  await tester.pumpAndSettle();
}

void _setViewSize(WidgetTester tester, Size size) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    _installSecureStorageFake();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
    VHHttpClient.deviceTypeProvider = null;
  });

  testWidgets('due meds filter narrows by route and clear restores rows', (
    tester,
  ) async {
    VHHttpClient.setClientForTesting(
      MockClient((req) async {
        expect(req.url.path, endsWith('/clinical/mar/due'));
        final wardId = req.url.queryParameters['ward_id'];
        final rows = [
          {
            'id': 1,
            'patient_uid': 'patient-a',
            'patient_name': 'Asha Menon',
            'medication_name': 'Aspirin',
            'dose': '75mg',
            'route': 'oral',
            'scheduled_time': DateTime.now().toIso8601String(),
            'status': 'scheduled',
            'bed_number': 'A1',
            'ward_id': 1,
            'ward_name': 'Ward A',
          },
          {
            'id': 2,
            'patient_uid': 'patient-b',
            'patient_name': 'Bala Rao',
            'medication_name': 'Ceftriaxone',
            'dose': '1g',
            'route': 'IV',
            'scheduled_time': DateTime.now().toIso8601String(),
            'status': 'scheduled',
            'bed_number': 'B1',
            'ward_id': 2,
            'ward_name': 'ICU',
          },
        ];
        return _jsonResponse({
          'success': true,
          'data': wardId == '2' ? [rows[1]] : rows,
        });
      }),
    );

    await _pumpStaffScreen(tester, const DueMedsScreen());

    expect(find.text('Aspirin'), findsOneWidget);
    expect(find.text('Ceftriaxone'), findsOneWidget);

    await _chooseDropdownOption(
      tester,
      const Key('due-meds-secondary-filter'),
      'IV',
    );

    expect(find.text('Aspirin'), findsNothing);
    expect(find.text('Ceftriaxone'), findsOneWidget);

    await tester.tap(find.byKey(const Key('due-meds-clear-filters')));
    await tester.pumpAndSettle();

    expect(find.text('Aspirin'), findsOneWidget);
    expect(find.text('Ceftriaxone'), findsOneWidget);
  });

  testWidgets('bed board filter narrows by status and clear restores beds', (
    tester,
  ) async {
    _installSecureStorageFake(role: 'NURSING_STAFF');
    VHHttpClient.setClientForTesting(
      MockClient((req) async {
        if (req.url.path.endsWith('/wards')) {
          return _jsonResponse({
            'success': true,
            'data': {
              'wards': [
                {'id': 1, 'name': 'ICU', 'bed_count': 2, 'occupied_count': 1},
                {
                  'id': 2,
                  'name': 'Ward B',
                  'bed_count': 1,
                  'occupied_count': 0,
                },
              ],
            },
          });
        }
        if (req.url.path.endsWith('/beds/ward/1')) {
          return _jsonResponse({
            'success': true,
            'data': {
              'beds': [
                {'id': 1, 'bed_number': 'A1', 'status': 'available'},
                {'id': 2, 'bed_number': 'A2', 'status': 'occupied'},
              ],
            },
          });
        }
        if (req.url.path.endsWith('/beds/ward/2')) {
          return _jsonResponse({
            'success': true,
            'data': {
              'beds': [
                {'id': 3, 'bed_number': 'B1', 'status': 'available'},
              ],
            },
          });
        }
        return _jsonResponse({'success': true, 'data': {}});
      }),
    );

    await _pumpStaffScreen(tester, const BedBoardScreen());
    await tester.tap(find.text('ICU'));
    await tester.pumpAndSettle();

    expect(find.text('Bed A1'), findsOneWidget);
    expect(find.text('Bed A2'), findsOneWidget);

    await _chooseDropdownOption(
      tester,
      const Key('bed-board-secondary-filter'),
      'Available',
    );

    expect(find.text('Bed A1'), findsOneWidget);
    expect(find.text('Bed A2'), findsNothing);

    await tester.tap(find.byKey(const Key('bed-board-clear-filters')));
    await tester.pumpAndSettle();

    expect(find.text('Bed A1'), findsOneWidget);
    expect(find.text('Bed A2'), findsOneWidget);
  });

  testWidgets('bed board desktop selects a bed into the detail pane', (
    tester,
  ) async {
    _setViewSize(tester, const Size(1280, 800));
    _installSecureStorageFake(role: 'NURSING_STAFF');
    VHHttpClient.setClientForTesting(
      MockClient((req) async {
        if (req.url.path.endsWith('/wards')) {
          return _jsonResponse({
            'success': true,
            'data': {
              'wards': [
                {'id': 1, 'name': 'ICU', 'bed_count': 2, 'occupied_count': 1},
              ],
            },
          });
        }
        if (req.url.path.endsWith('/beds/ward/1')) {
          return _jsonResponse({
            'success': true,
            'data': {
              'beds': [
                {'id': 1, 'bed_number': 'A1', 'status': 'available'},
                {
                  'id': 2,
                  'bed_number': 'A2',
                  'status': 'occupied',
                  'patient_full_name': 'Bala Rao',
                  'patient_hospital_number': 'H123',
                  'patient_age': 42,
                  'patient_gender': 'male',
                  'patient_uid': 'patient-b',
                  'admission_id': 'adm-2',
                },
              ],
            },
          });
        }
        return _jsonResponse({'success': true, 'data': {}});
      }),
    );

    await _pumpStaffScreen(tester, const BedBoardScreen());
    await tester.tap(find.text('ICU'));
    await tester.pumpAndSettle();

    expect(find.text('Select a bed to view details'), findsOneWidget);
    expect(find.text('Bed A2'), findsOneWidget);

    await tester.tap(find.text('Bed A2').first);
    await tester.pumpAndSettle();

    expect(find.text('Select a bed to view details'), findsNothing);
    expect(find.text('Hospital ID'), findsOneWidget);
    expect(find.text('H123'), findsAtLeastNWidgets(1));
  });

  testWidgets(
    'admissions filters narrow by ward/status and clear restores active rows',
    (tester) async {
      VHHttpClient.setClientForTesting(
        MockClient((req) async {
          if (req.url.path.endsWith('/admissions/ward-options')) {
            return _jsonResponse({
              'success': true,
              'data': {
                'wards': [
                  {'id': 1, 'name': 'ICU', 'label': 'ICU'},
                  {'id': 2, 'name': 'Ward B', 'label': 'Ward B'},
                ],
              },
            });
          }
          if (req.url.path.endsWith('/admissions')) {
            final ward = req.url.queryParameters['ward'];
            final status = req.url.queryParameters['status'];
            final activeRows = [
              {
                'id': 1,
                'patient_name': 'Asha Menon',
                'ward': 'ICU',
                'bed_number': 'A1',
                'status': 'admitted',
                'priority': 'routine',
              },
              {
                'id': 2,
                'patient_name': 'Bala Rao',
                'ward': 'Ward B',
                'bed_number': 'B1',
                'status': 'admitted',
                'priority': 'urgent',
              },
            ];
            final rows = status == admissionDischargedStatus
                ? [
                    {
                      'id': 3,
                      'patient_name': 'Chitra Iyer',
                      'ward': 'ICU',
                      'bed_number': 'A2',
                      'status': 'discharged',
                      'priority': 'routine',
                    },
                  ]
                : ward == 'ICU'
                ? [activeRows[0]]
                : activeRows;
            return _jsonResponse({
              'success': true,
              'data': rows,
              'meta': {
                'pagination': {'total': rows.length},
                'scope': {'type': 'full'},
              },
            });
          }
          return _jsonResponse({'success': true, 'data': {}});
        }),
      );

      await _pumpStaffScreen(tester, const AdmissionScreen());

      expect(find.text('Asha Menon'), findsOneWidget);
      expect(find.text('Bala Rao'), findsOneWidget);

      await _chooseDropdownOption(
        tester,
        const Key('admissions-ward-filter'),
        'ICU',
      );

      expect(find.text('Asha Menon'), findsOneWidget);
      expect(find.text('Bala Rao'), findsNothing);

      await tester.tap(find.byKey(const Key('admissions-clear-filters')));
      await tester.pumpAndSettle();

      expect(find.text('Asha Menon'), findsOneWidget);
      expect(find.text('Bala Rao'), findsOneWidget);

      await _chooseDropdownOption(
        tester,
        const Key('admissions-secondary-filter'),
        'Discharged',
      );

      expect(find.text('Chitra Iyer'), findsOneWidget);
      expect(find.text('Asha Menon'), findsNothing);

      await tester.tap(find.byKey(const Key('admissions-clear-filters')));
      await tester.pumpAndSettle();

      expect(find.text('Asha Menon'), findsOneWidget);
      expect(find.text('Bala Rao'), findsOneWidget);
    },
  );
}
