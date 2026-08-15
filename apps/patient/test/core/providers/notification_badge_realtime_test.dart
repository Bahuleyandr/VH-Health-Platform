// test/core/providers/notification_badge_realtime_test.dart
//
// Realtime notifications must SURFACE, not just buffer. WebSocketProvider has
// subscribed the `notification` channel since the #867 realtime consolidation,
// but its buffer's only consumer — NotificationProvider.mergeFromWebSocket —
// lost its caller when websocket_service.dart was deleted, so WS-delivered
// notifications piled up unseen and the unread badge only moved on the next
// poll. These tests pin the re-attached wire (bindWebSocket): a WS event moves
// the badge count live and drains the buffer, pre-wire events are drained at
// bind time, an unwired buffer stays bounded, and main.dart actually installs
// the wire.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/core/widgets/main_scaffold_go_router.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/realtime_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    UserProvider.instance = null;
  });

  test('a WS notification event moves the unread count live and drains the '
      'buffer', () async {
    final realtime = _FakeRealtimeBinding();
    final webSocketProvider = WebSocketProvider(
      realtimeBinding: realtime,
      patientUidReader: () async => 'patient-uid-1',
    );
    addTearDown(webSocketProvider.dispose);
    final notificationProvider = NotificationProvider()
      ..bindWebSocket(webSocketProvider);
    addTearDown(notificationProvider.dispose);

    await webSocketProvider.listen();
    expect(notificationProvider.unreadCount, 0);

    realtime.emit('notification', {'id': 'n-1', 'title': 'Result ready'});
    await Future<void>.delayed(Duration.zero);

    expect(notificationProvider.unreadCount, 1);
    expect(webSocketProvider.wsNotifications, isEmpty);

    realtime.emit('notification', {'id': 'n-2'});
    realtime.emit('notification', {'id': 'n-3'});
    await Future<void>.delayed(Duration.zero);

    expect(notificationProvider.unreadCount, 3);
    expect(webSocketProvider.wsNotifications, isEmpty);
  });

  test(
    'events buffered before the wire attaches are drained at bind time',
    () async {
      final realtime = _FakeRealtimeBinding();
      final webSocketProvider = WebSocketProvider(
        realtimeBinding: realtime,
        patientUidReader: () async => 'patient-uid-1',
      );
      addTearDown(webSocketProvider.dispose);

      await webSocketProvider.listen();
      realtime.emit('notification', {'id': 'early-1'});
      realtime.emit('notification', {'id': 'early-2'});
      await Future<void>.delayed(Duration.zero);
      expect(webSocketProvider.wsNotifications, hasLength(2));

      final notificationProvider = NotificationProvider()
        ..bindWebSocket(webSocketProvider);
      addTearDown(notificationProvider.dispose);

      expect(notificationProvider.unreadCount, 2);
      expect(webSocketProvider.wsNotifications, isEmpty);
    },
  );

  test('an unwired notification buffer is bounded for the life of the '
      'session', () async {
    final realtime = _FakeRealtimeBinding();
    final webSocketProvider = WebSocketProvider(
      realtimeBinding: realtime,
      patientUidReader: () async => 'patient-uid-1',
    );
    addTearDown(webSocketProvider.dispose);

    await webSocketProvider.listen();
    const cap = WebSocketProvider.maxBufferedNotifications;
    for (var i = 0; i < cap + 25; i++) {
      realtime.emit('notification', {'id': 'n-$i'});
    }
    await Future<void>.delayed(Duration.zero);

    expect(webSocketProvider.wsNotifications, hasLength(cap));
    // Oldest events are dropped first.
    expect(webSocketProvider.wsNotifications.first, containsPair('id', 'n-25'));
    expect(
      webSocketProvider.wsNotifications.last,
      containsPair('id', 'n-${cap + 24}'),
    );
  });

  testWidgets('a WS notification event updates the bottom-nav unread badge '
      'live', (tester) async {
    SharedPreferences.setMockInitialValues({});

    final realtime = _FakeRealtimeBinding();
    final webSocketProvider = WebSocketProvider(
      realtimeBinding: realtime,
      patientUidReader: () async => 'patient-uid-1',
    );
    addTearDown(webSocketProvider.dispose);
    final notificationProvider = NotificationProvider()
      ..bindWebSocket(webSocketProvider);
    addTearDown(notificationProvider.dispose);
    await webSocketProvider.listen();

    final router = GoRouter(
      initialLocation: '/home',
      routes: [
        ShellRoute(
          builder: (context, state, child) =>
              MainScaffoldGoRouter(child: child),
          routes: [
            GoRoute(path: '/home', builder: (_, _) => const Text('Home page')),
          ],
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider(create: (_) => UserProvider()),
          ChangeNotifierProvider<NotificationProvider>.value(
            value: notificationProvider,
          ),
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

    // Poll-only baseline: no unread badge yet.
    expect(find.text('1'), findsNothing);

    realtime.emit('notification', {'id': 'n-live', 'title': 'New message'});
    await tester.pumpAndSettle();

    expect(find.text('1'), findsAtLeastNWidgets(1));
  });

  test('main.dart wires the WebSocket buffer into NotificationProvider', () {
    // Source-level pin, same technique as patient_session_expiry_wiring_test:
    // _VHRootState cannot be instantiated in a unit test (Firebase, screen
    // protector), and this wire is exactly what was silently lost in #867.
    final mainSource = File('lib/main.dart').readAsStringSync();
    expect(
      mainSource,
      contains('bindWebSocket(_webSocketProvider)'),
      reason:
          'without bindWebSocket the WS notification buffer has no consumer '
          'and the unread badge is poll-only again',
    );
    expect(
      mainSource,
      contains('ChangeNotifierProvider<NotificationProvider>.value'),
      reason:
          'the widget tree must be served the SAME NotificationProvider '
          'instance that is bound to the WebSocket wire',
    );
  });
}

class _FakeRealtimeBinding extends ChangeNotifier
    implements PatientRealtimeBinding {
  final Map<String, StreamController<RealtimeEvent>> _controllers = {};
  final Set<String> _acknowledged = {};

  @override
  Future<void> ensureConnected() async {}

  @override
  Stream<RealtimeEvent> events(String channel, {bool broadcastChannel = true}) {
    return _controllers
        .putIfAbsent(channel, StreamController<RealtimeEvent>.broadcast)
        .stream;
  }

  @override
  bool isSubscribed(String channel) => _acknowledged.contains(channel);

  void emit(String channel, Map<String, dynamic> data) {
    _controllers[channel]?.add(
      RealtimeEvent(channel: channel, data: data, at: DateTime.now()),
    );
  }

  @override
  void unsubscribe(String channel) {
    _acknowledged.remove(channel);
    _controllers.remove(channel)?.close();
  }

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.close();
    }
    super.dispose();
  }
}
