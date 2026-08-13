import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_staff/core/providers/message_unread_provider.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';
import 'package:vhhealth_staff/core/services/recent_patients_service.dart';
import 'package:vhhealth_staff/features/settings/screens/settings_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    SharedPreferences.setMockInitialValues({});
    RecentPatientsService.debugStaffIdentityOverride = null;
  });

  tearDown(() {
    RecentPatientsService.debugStaffIdentityOverride = null;
  });

  testWidgets(
    'PIN reauthentication tears down the authenticated session before clear and navigation',
    (tester) async {
      final timeout = SessionTimeoutProvider(
        timeoutDuration: const Duration(hours: 1),
      )..startTracking();
      addTearDown(timeout.dispose);
      await tester.pumpWidget(
        ChangeNotifierProvider<SessionTimeoutProvider>.value(
          value: timeout,
          child: const MaterialApp(home: SizedBox.shrink()),
        ),
      );

      final order = <String>[];
      final unchanged = await applySettingsPinReauthentication(
        const {'reauthenticationRequired': false},
        endAuthenticatedSession: () => order.add('teardown'),
        timeout: timeout,
        forcedLogout: () async {
          order.add('credential clear');
          return 0;
        },
        navigateToLogin: () => order.add('navigation'),
      );
      expect(unchanged, isFalse);
      expect(order, isEmpty);
      expect(timeout.isTracking, isTrue);

      final signedOut = await applySettingsPinReauthentication(
        const {'reauthenticationRequired': true},
        endAuthenticatedSession: () => order.add('teardown'),
        timeout: timeout,
        forcedLogout: () async {
          order.add('credential clear');
          return 0;
        },
        navigateToLogin: () => order.add('navigation'),
      );
      await tester.pump();

      expect(signedOut, isTrue);
      expect(order, <String>['teardown', 'credential clear', 'navigation']);
      expect(timeout.isTracking, isFalse);
      expect(timeout.isSessionLocked, isFalse);
    },
  );

  testWidgets('device-removal backend failure leaves the session intact', (
    tester,
  ) async {
    final timeout = SessionTimeoutProvider(
      timeoutDuration: const Duration(hours: 1),
    )..startTracking();
    addTearDown(timeout.dispose);
    late BuildContext context;
    await tester.pumpWidget(
      ChangeNotifierProvider<SessionTimeoutProvider>.value(
        value: timeout,
        child: MaterialApp(
          home: Builder(
            builder: (hostContext) {
              context = hostContext;
              return const SizedBox.shrink();
            },
          ),
        ),
      ),
    );

    var teardownCalls = 0;
    var revocationCalls = 0;
    var navigationCalls = 0;
    await expectLater(
      removeSettingsRegisteredDevice(
        context,
        'remote-device',
        removeDevice: (_) async => throw StateError('backend unavailable'),
        applyRemovalRevocation: (_) async {
          revocationCalls += 1;
          return false;
        },
        endAuthenticatedSession: () => teardownCalls += 1,
        navigateToLogin: () => navigationCalls += 1,
      ),
      throwsA(isA<StateError>()),
    );

    expect(teardownCalls, 0);
    expect(revocationCalls, 0);
    expect(navigationCalls, 0);
    expect(timeout.isTracking, isTrue);
    expect(timeout.isSessionLocked, isFalse);
    timeout.stopTracking();
  });

  testWidgets(
    'device removal still clears credentials after push teardown failure',
    (tester) async {
      late BuildContext context;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (hostContext) {
              context = hostContext;
              return const SizedBox.shrink();
            },
          ),
        ),
      );

      final order = <String>[];
      await removeSettingsRegisteredDevice(
        context,
        'remote-device',
        removeDevice: (_) async {
          order.add('backend removal');
          return const {};
        },
        endAuthenticatedSession: () async {
          order.add('push teardown');
          throw StateError('push backend unavailable');
        },
        applyRemovalRevocation: (_) async {
          order.add('credential clear');
          return false;
        },
        navigateToLogin: () => order.add('navigation'),
      );

      expect(order, <String>[
        'backend removal',
        'push teardown',
        'credential clear',
        'navigation',
      ]);
    },
  );

  testWidgets('concurrent Settings revocations navigate only once', (
    tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));

    final releaseTeardown = Completer<void>();
    var teardownCalls = 0;
    var credentialClearCalls = 0;
    var navigationCalls = 0;
    Future<void> start() => forceSettingsReauthentication(
      endAuthenticatedSession: () async {
        teardownCalls += 1;
        await releaseTeardown.future;
      },
      forcedLogout: () async {
        credentialClearCalls += 1;
        return 0;
      },
      navigateToLogin: () => navigationCalls += 1,
    );

    final first = start();
    final second = start();
    await tester.pump();
    expect(teardownCalls, 1);

    releaseTeardown.complete();
    await Future.wait([first, second]);

    expect(teardownCalls, 1);
    expect(credentialClearCalls, 1);
    expect(navigationCalls, 1);
  });

  testWidgets(
    'Settings revocation removes account A recents and restarts subscriptions cleanly for account B',
    (tester) async {
      var activeAccount = 'A';
      final messages = MessageUnreadProvider(
        loadUnreadCount: () async => {
          'unread_count': activeAccount == 'A' ? 7 : 2,
        },
      );
      final notifications = _FailingNotificationProvider();
      final timeout = SessionTimeoutProvider(
        timeoutDuration: const Duration(hours: 1),
      )..startTracking();
      addTearDown(messages.dispose);
      addTearDown(notifications.dispose);
      addTearDown(timeout.dispose);

      RecentPatientsService.debugStaffIdentityOverride = 'staff-a';
      await RecentPatientsService.add('patient-a', 'Alice');
      await messages.start();
      expect(messages.unreadCount, 7);

      late BuildContext context;
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<MessageUnreadProvider>.value(
              value: messages,
            ),
            ChangeNotifierProvider<NotificationProvider>.value(
              value: notifications,
            ),
            ChangeNotifierProvider<SessionTimeoutProvider>.value(
              value: timeout,
            ),
          ],
          child: MaterialApp(
            home: Builder(
              builder: (hostContext) {
                context = hostContext;
                return const SizedBox.shrink();
              },
            ),
          ),
        ),
      );

      var credentialClearCalls = 0;
      var navigationCalls = 0;
      await removeSettingsRegisteredDevice(
        context,
        'remote-device',
        removeDevice: (_) async => const {},
        applyRemovalRevocation: (_) async {
          credentialClearCalls += 1;
          return false;
        },
        navigateToLogin: () => navigationCalls += 1,
      );

      expect(notifications.endCalls, 1);
      expect(notifications.lastUnregisterBackend, isTrue);
      expect(messages.unreadCount, 0);
      expect(credentialClearCalls, 1);
      expect(navigationCalls, 1);

      expect(await RecentPatientsService.getAll(), isEmpty);
      RecentPatientsService.debugStaffIdentityOverride = 'staff-b';
      expect(await RecentPatientsService.getAll(), isEmpty);

      activeAccount = 'B';
      await messages.start();
      expect(messages.unreadCount, 2);
      messages.stop();
    },
  );
}

class _FailingNotificationProvider extends NotificationProvider {
  int endCalls = 0;
  bool? lastUnregisterBackend;

  @override
  Future<void> endAuthenticatedSession({bool unregisterBackend = true}) async {
    endCalls += 1;
    lastUnregisterBackend = unregisterBackend;
    throw StateError('push backend unavailable');
  }
}
