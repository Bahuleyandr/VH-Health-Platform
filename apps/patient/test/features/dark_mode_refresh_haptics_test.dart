import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart';
import 'package:vhhealth/core/widgets/main_scaffold_go_router.dart';
import 'package:vhhealth/features/family/screens/family_screen.dart';
import 'package:vhhealth/features/medications/screens/medication_reminders_screen.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    _installSecureStorageFake();
    _installNotificationPluginFake();
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('dexterous.com/flutter/local_notifications'),
          null,
        );
  });

  testWidgets('family list can be pulled to refresh', (tester) async {
    var familyRequests = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/users/family-members'));
        familyRequests++;
        return http.Response(
          '{"data":[{"id":"fam-1","name":"Asha Rao","relationship":"Parent","phone":"9876543210","dateOfBirth":"1970-01-01"}]}',
          200,
        );
      }),
    );

    await tester.pumpWidget(const _LocalizedHarness(child: FamilyScreen()));
    await tester.pumpAndSettle();

    expect(find.byType(RefreshIndicator), findsOneWidget);
    expect(find.text('Asha Rao'), findsOneWidget);

    await tester.drag(find.byType(ListView), const Offset(0, 320));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();

    expect(familyRequests, greaterThanOrEqualTo(2));
  });

  testWidgets('medication reminder list keeps pull-to-refresh on short lists', (
    tester,
  ) async {
    var reminderRequests = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        expect(request.url.path, endsWith('/reminders/medication'));
        reminderRequests++;
        return http.Response(
          '{"data":[{"id":7,"medication_name":"Iron","dosage":"1 tab","frequency":"once_daily","reminder_times":["08:00"],"start_date":"2026-07-01","is_active":false}]}',
          200,
        );
      }),
    );

    await tester.pumpWidget(
      const _LocalizedHarness(child: MedicationRemindersScreen()),
    );
    await tester.pumpAndSettle();

    expect(find.byType(RefreshIndicator), findsOneWidget);
    expect(find.text('Iron'), findsOneWidget);

    await tester.drag(find.byType(ListView), const Offset(0, 320));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();

    expect(reminderRequests, greaterThanOrEqualTo(2));
  });

  testWidgets('dial haptics are limited to feature selection clicks', (
    tester,
  ) async {
    final hapticCalls = _recordHapticCalls();
    var selected = false;

    await tester.pumpWidget(
      _LocalizedHarness(
        child: Scaffold(
          body: Center(
            child: CircularFeatureDial(
              size: 430,
              features: [
                FeatureIconData(
                  icon: Icons.favorite,
                  label: 'Care',
                  color: Colors.teal,
                  onTap: (_) => selected = true,
                ),
              ],
              onCenterDoubleTap: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    hapticCalls.clear();
    await tester.tap(find.text('Care'));
    await tester.pump(const Duration(milliseconds: 700));

    expect(selected, isTrue);
    expect(_selectionClickCount(hapticCalls), 1);

    hapticCalls.clear();
    await tester.drag(find.byType(CircularFeatureDial), const Offset(60, 0));
    await tester.pump(const Duration(milliseconds: 700));
    expect(hapticCalls, isEmpty);

    hapticCalls.clear();
    await tester.tapAt(tester.getCenter(find.byType(CircularFeatureDial)));
    await tester.pump(const Duration(milliseconds: 100));
    expect(hapticCalls, isEmpty);
  });

  testWidgets('bottom navigation taps emit a selection click', (tester) async {
    final hapticCalls = _recordHapticCalls();
    final router = GoRouter(
      initialLocation: '/home',
      routes: [
        ShellRoute(
          builder: (context, state, child) =>
              MainScaffoldGoRouter(child: child),
          routes: [
            GoRoute(path: '/home', builder: (_, _) => const Text('Home page')),
            GoRoute(
              path: '/health',
              builder: (_, _) => const Text('Health page'),
            ),
            GoRoute(
              path: '/notifications',
              builder: (_, _) => const Text('Notifications page'),
            ),
            GoRoute(
              path: '/settings',
              builder: (_, _) => const Text('Settings page'),
            ),
          ],
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => UserProvider()),
          ChangeNotifierProvider(create: (_) => NotificationProvider()),
          ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ],
        child: MaterialApp.router(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          routerConfig: router,
        ),
      ),
    );
    await tester.pumpAndSettle();

    hapticCalls.clear();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();

    expect(_selectionClickCount(hapticCalls), 1);
  });
}

class _LocalizedHarness extends StatelessWidget {
  const _LocalizedHarness({required this.child});

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

List<MethodCall> _recordHapticCalls() {
  final calls = <MethodCall>[];
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'HapticFeedback.vibrate') {
          calls.add(call);
        }
        return null;
      });
  return calls;
}

int _selectionClickCount(List<MethodCall> calls) {
  return calls
      .where((call) => call.arguments == 'HapticFeedbackType.selectionClick')
      .length;
}

void _installNotificationPluginFake() {
  const channel = MethodChannel('dexterous.com/flutter/local_notifications');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (call) async {
        if (call.method.toLowerCase().contains('permission') ||
            call.method == 'areNotificationsEnabled') {
          return true;
        }
        if (call.method == 'pendingNotificationRequests') {
          return <Map<String, Object?>>[];
        }
        return null;
      });
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
