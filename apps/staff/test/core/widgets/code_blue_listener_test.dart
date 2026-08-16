import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/services/realtime_provider.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/core/providers/session_timeout_provider.dart';
import 'package:vhhealth_staff/core/providers/websocket_provider.dart';
import 'package:vhhealth_staff/core/widgets/code_blue_listener.dart';
import 'package:vhhealth_staff/core/widgets/logout_flow.dart';

class _FakeRealtimeProvider extends RealtimeProvider {
  final Map<String, StreamController<RealtimeEvent>> controllers = {};

  @override
  bool get isConnected => true;

  @override
  Future<void> ensureConnected() async {}

  @override
  Stream<RealtimeEvent> events(String channel, {bool broadcastChannel = true}) {
    return (controllers[channel] ??=
            StreamController<RealtimeEvent>.broadcast())
        .stream;
  }

  Future<void> close() async {
    for (final controller in controllers.values) {
      await controller.close();
    }
  }
}

class _FakeCodeBluePresentation implements CodeBluePresentation {
  final Completer<void> _completed = Completer<void>();
  bool dismissed = false;

  @override
  Future<void> get completed => _completed.future;

  @override
  void dismiss() {
    dismissed = true;
    if (!_completed.isCompleted) _completed.complete();
  }
}

class _LateCodeBlueStream extends Stream<RealtimeEvent> {
  final StreamController<RealtimeEvent> _controller =
      StreamController<RealtimeEvent>.broadcast();
  void Function(RealtimeEvent)? _listener;

  void add(RealtimeEvent event) => _controller.add(event);

  void deliverAfterCancellation(RealtimeEvent event) => _listener?.call(event);

  Future<void> close() => _controller.close();

  @override
  StreamSubscription<RealtimeEvent> listen(
    void Function(RealtimeEvent event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    _listener = onData;
    return _controller.stream.listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }
}

class _FakeWebSocketProvider extends WebSocketProvider {
  final _LateCodeBlueStream events = _LateCodeBlueStream();
  bool _active = false;

  @override
  bool get hasAuthenticatedSession => _active;

  @override
  Stream<RealtimeEvent> get codeBlueEvents => events;

  @override
  Future<void> beginAuthenticatedSession() async {
    _active = true;
    notifyListeners();
  }

  @override
  Future<void> endAuthenticatedSession() async {
    _active = false;
    notifyListeners();
  }
}

class _LockNotificationProvider extends NotificationProvider {
  int endCalls = 0;

  @override
  Future<void> endAuthenticatedSession({bool unregisterBackend = true}) async {
    endCalls += 1;
  }
}

RealtimeEvent _codeBlueEvent({
  required int eventId,
  required String patientId,
}) {
  return RealtimeEvent(
    channel: 'staff:code-blue',
    data: <String, dynamic>{
      'eventId': eventId,
      'patientId': patientId,
      'ward': '3W',
      'bedNumber': '12',
    },
    at: DateTime(2026, 8, 13),
  );
}

void main() {
  testWidgets(
    'deduplicates event IDs and shows one dialog per unique Code Blue',
    (tester) async {
      final realtime = _FakeRealtimeProvider();
      final provider = WebSocketProvider()..bind(realtime);
      await provider.beginAuthenticatedSession();
      final notificationEventIds = <String>[];
      final navigatorKey = GlobalKey<NavigatorState>();

      await tester.pumpWidget(
        ChangeNotifierProvider<WebSocketProvider>.value(
          value: provider,
          child: MaterialApp(
            navigatorKey: navigatorKey,
            home: CodeBlueListener(
              navigatorKey: navigatorKey,
              notificationPresenter: (data) async {
                notificationEventIds.add(data['eventId'].toString());
              },
              child: const Scaffold(body: Text('Staff home')),
            ),
          ),
        ),
      );

      realtime.controllers['staff:code-blue']!
        ..add(_codeBlueEvent(eventId: 41, patientId: 'patient-a'))
        ..add(_codeBlueEvent(eventId: 41, patientId: 'patient-a'))
        ..add(_codeBlueEvent(eventId: 42, patientId: 'patient-b'));
      await tester.pumpAndSettle();

      expect(notificationEventIds, <String>['41', '42']);
      expect(find.text('CODE BLUE'), findsOneWidget);
      expect(find.textContaining('patient-a'), findsOneWidget);

      await tester.tap(find.text('ACKNOWLEDGED'));
      await tester.pumpAndSettle();

      expect(find.text('CODE BLUE'), findsOneWidget);
      expect(find.textContaining('patient-b'), findsOneWidget);

      await tester.tap(find.text('ACKNOWLEDGED'));
      await tester.pumpAndSettle();
      expect(find.text('CODE BLUE'), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
      provider.dispose();
      await realtime.close();
    },
  );

  testWidgets('logout dismisses presentation and rejects late session events', (
    tester,
  ) async {
    final provider = _FakeWebSocketProvider();
    await provider.beginAuthenticatedSession();
    final notificationEventIds = <String>[];
    final presentations = <_FakeCodeBluePresentation>[];
    final navigatorKey = GlobalKey<NavigatorState>();

    await tester.pumpWidget(
      ChangeNotifierProvider<WebSocketProvider>.value(
        value: provider,
        child: MaterialApp(
          navigatorKey: navigatorKey,
          home: CodeBlueListener(
            navigatorKey: navigatorKey,
            notificationPresenter: (data) async {
              notificationEventIds.add(data['eventId'].toString());
            },
            dialogPresenter: (_, _) {
              final presentation = _FakeCodeBluePresentation();
              presentations.add(presentation);
              return presentation;
            },
            child: const Scaffold(body: Text('Staff home')),
          ),
        ),
      ),
    );
    provider.events.add(
      _codeBlueEvent(eventId: 71, patientId: 'previous-account'),
    );
    await tester.pump();
    expect(presentations, hasLength(1));
    expect(presentations.single.dismissed, isFalse);

    await provider.endAuthenticatedSession().timeout(
      const Duration(seconds: 3),
    );
    expect(presentations.single.dismissed, isTrue);
    expect(find.text('Staff home'), findsOneWidget);

    provider.events.deliverAfterCancellation(
      _codeBlueEvent(eventId: 72, patientId: 'late-previous-account'),
    );
    expect(notificationEventIds, <String>['71']);
    expect(presentations, hasLength(1));
    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    await provider.events.close().timeout(const Duration(seconds: 3));
  });

  testWidgets(
    'idle lock tears down Code Blue before a delayed queue count can deliver',
    (tester) async {
      final provider = _FakeWebSocketProvider();
      final notifications = _LockNotificationProvider();
      final counterStarted = Completer<void>();
      final releaseCounter = Completer<void>();
      final cleanupCompleted = Completer<void>();
      final notificationEventIds = <String>[];
      final presentations = <_FakeCodeBluePresentation>[];
      final navigatorKey = GlobalKey<NavigatorState>();
      late BuildContext sessionContext;
      late SessionTimeoutProvider timeout;
      FlutterSecureStorage.setMockInitialValues({});
      SharedPreferences.setMockInitialValues({});
      await provider.beginAuthenticatedSession();

      timeout = SessionTimeoutProvider(
        timeoutDuration: const Duration(milliseconds: 10),
        beforeTimeoutCleanup: () => stopStaffRealtimePollers(
          sessionContext,
          unregisterNotificationBackend: true,
        ),
        pendingOfflineWriteCount: () async {
          counterStarted.complete();
          await releaseCounter.future;
          return 0;
        },
        onTimeoutCleanup: () async {
          cleanupCompleted.complete();
        },
      );
      addTearDown(timeout.dispose);
      addTearDown(notifications.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<WebSocketProvider>.value(value: provider),
            ChangeNotifierProvider<NotificationProvider>.value(
              value: notifications,
            ),
            ChangeNotifierProvider<SessionTimeoutProvider>.value(
              value: timeout,
            ),
          ],
          child: Builder(
            builder: (context) {
              sessionContext = context;
              return MaterialApp(
                navigatorKey: navigatorKey,
                home: CodeBlueListener(
                  navigatorKey: navigatorKey,
                  notificationPresenter: (data) async {
                    notificationEventIds.add(data['eventId'].toString());
                  },
                  dialogPresenter: (_, _) {
                    final presentation = _FakeCodeBluePresentation();
                    presentations.add(presentation);
                    return presentation;
                  },
                  child: const Scaffold(body: Text('Staff home')),
                ),
              );
            },
          ),
        ),
      );

      timeout.startTracking();
      await tester.pump(const Duration(milliseconds: 10));
      await tester.pump();
      await counterStarted.future.timeout(const Duration(seconds: 2));

      expect(timeout.isSessionLocked, isTrue);
      expect(provider.hasAuthenticatedSession, isFalse);
      expect(notifications.endCalls, 1);

      provider.events.deliverAfterCancellation(
        _codeBlueEvent(eventId: 81, patientId: 'locked-session'),
      );
      await tester.pump();
      expect(notificationEventIds, isEmpty);
      expect(presentations, isEmpty);

      releaseCounter.complete();
      await cleanupCompleted.future.timeout(const Duration(seconds: 2));
      await tester.pumpWidget(const SizedBox.shrink());
      provider.dispose();
      await provider.events.close().timeout(const Duration(seconds: 3));
    },
  );

  test('Code Blue listener is mounted once above routing', () {
    final mainSource = File('lib/main.dart').readAsStringSync();
    final scaffoldSource = File('lib/core/widgets/staff_scaffold.dart')
        .readAsStringSync();
    final listenerSource = File('lib/core/widgets/code_blue_listener.dart')
        .readAsStringSync();

    expect(RegExp(r'CodeBlueListener\(').allMatches(mainSource), hasLength(1));
    expect(scaffoldSource, isNot(contains('CodeBlueListener(')));
    expect(listenerSource, isNot(contains('RealtimeClient.instance')));
  });
}
