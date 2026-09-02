import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/vhhealth_core.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/opd/screens/op_doctor_workspace_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await ConnectivitySyncService.instance.resetForTesting();
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    final store = <String, String>{};
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          final args = Map<String, dynamic>.from(
            call.arguments as Map? ?? const <String, dynamic>{},
          );
          return switch (call.method) {
            'read' => store[args['key']],
            'write' => () {
              store[args['key'] as String] = args['value'] as String;
              return null;
            }(),
            'delete' => store.remove(args['key']),
            'readAll' => Map<String, String>.from(store),
            'deleteAll' => () {
              store.clear();
              return null;
            }(),
            'containsKey' => store.containsKey(args['key']),
            _ => null,
          };
        });
  });

  tearDown(() async {
    VHHttpClient.resetClientForTesting();
    await ConnectivitySyncService.instance.resetForTesting();
    const channel = MethodChannel(
      'plugins.it_nomads.com/flutter_secure_storage',
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets(
    'no-message OP completion failure renders Malayalam fallback, not a key',
    (tester) async {
      VHHttpClient.setClientForTesting(
        MockClient((request) async {
          if (request.url.path.endsWith('/appointments/7/complete')) {
            return http.Response(
              jsonEncode(<String, dynamic>{'success': false}),
              400,
              headers: const {'content-type': 'application/json'},
            );
          }
          return http.Response(
            jsonEncode(<String, dynamic>{
              'success': true,
              'data': <String, dynamic>{},
            }),
            200,
            headers: const {'content-type': 'application/json'},
          );
        }),
      );
      final strings = AppStrings.forLocale(const Locale('ml'));
      final completeLabel = strings.lookup(
        's4.lib.op_doctor_workspace.complete',
      );

      tester.view.physicalSize = const Size(1600, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        ChangeNotifierProvider(
          create: (_) => ThemeProvider(),
          child: const MaterialApp(
            locale: Locale('ml'),
            supportedLocales: AppStrings.supportedLocales,
            localizationsDelegates: [
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: OpDoctorWorkspaceScreen(
              patientUid: 'patient-7',
              patientName: 'Patient Seven',
              appointmentId: 7,
              status: 'CONFIRMED',
            ),
          ),
        ),
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 150)),
      );
      for (var attempt = 0; attempt < 50; attempt += 1) {
        await tester.pump(const Duration(milliseconds: 100));
        if (find.text(completeLabel).evaluate().isNotEmpty) break;
      }

      expect(find.text(completeLabel), findsWidgets);
      await tester.tap(find.text(completeLabel).first);
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 100)),
      );
      final failureLabel = strings.lookup('presentation.request_failed');
      for (var attempt = 0; attempt < 30; attempt += 1) {
        await tester.pump(const Duration(milliseconds: 100));
        if (find.text(failureLabel).evaluate().isNotEmpty) break;
      }

      expect(find.text(failureLabel), findsOneWidget);
      expect(find.text('presentation.request_failed'), findsNothing);
      expect(find.text('Request failed. Please try again.'), findsNothing);
      expect(find.text('Request failed (400)'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
