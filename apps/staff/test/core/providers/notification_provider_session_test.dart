import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/config/api_config.dart';
import 'package:vhhealth_staff/core/providers/notification_provider.dart';
import 'package:vhhealth_staff/core/services/staff_notification_session.dart';

const staffUidA = '00000000-0000-4000-8000-0000000000a1';
const staffUidB = '00000000-0000-4000-8000-0000000000b2';
const tenantA = '00000000-0000-4000-8000-000000000011';
const tenantB = '00000000-0000-4000-8000-000000000022';

StaffNotificationAudience _audience(
  String uid, {
  int registrationEpoch = 1,
  String sessionEpoch = 'session-family-1',
}) => StaffNotificationAudience(
  version: 1,
  tenantId: uid == staffUidA ? tenantA : tenantB,
  recipientUid: uid,
  deviceId: 'installation-1',
  registrationEpoch: '$registrationEpoch',
  sessionEpoch: sessionEpoch,
  authorizationEpoch: '4',
);

StaffJwtClaims _claims(String uid) => StaffJwtClaims(
  staffUid: uid,
  tenantId: uid == staffUidA ? tenantA : tenantB,
  tokenEpoch: '4',
  sessionEpoch: 'session-family-1',
  expiresAt: DateTime.utc(2035),
);

RemoteMessage _message(
  StaffNotificationAudience audience, {
  String type = 'code_blue',
  String? title,
}) => RemoteMessage(
  data: {
    'type': type,
    'title': ?title,
    'notification_authority_version': '${audience.version}',
    'notification_tenant_id': audience.tenantId,
    'notification_recipient_uid': audience.recipientUid,
    'notification_device_id': audience.deviceId,
    'notification_registration_epoch': audience.registrationEpoch,
    'notification_session_epoch': audience.sessionEpoch,
    'notification_authorization_epoch': audience.authorizationEpoch,
    'notification_expires_at':
        '${DateTime.utc(2035).millisecondsSinceEpoch ~/ 1000}',
  },
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'account handoff unregisters, rotates, clears, and resubscribes',
    () async {
      final messaging = _FakeNotificationMessaging();
      var registerCalls = 0;
      var unregisterCalls = 0;
      var activeStaffUid = staffUidA;
      final registeredTokens = <String>[];
      final provider = NotificationProvider(
        messaging: messaging,
        registerDevice:
            ({required fcmToken, required platform, required phone}) async {
              registerCalls += 1;
              registeredTokens.add(fcmToken);
              return _audience(activeStaffUid);
            },
        unregisterDevice: () async {
          unregisterCalls += 1;
        },
        phoneLoader: () async =>
            registerCalls == 0 ? '+919111111111' : '+919222222222',
        staffUidLoader: () async => activeStaffUid,
        isAuthenticated: () async => true,
        notificationClaimsLoader: () async => _claims(activeStaffUid),
        notificationAuthorityValidator: (_) async => true,
        platformLoader: () => 'android',
        sessionStore: _testSessionStore(),
        clearDeliveredNotifications: () async {},
        supportsPush: true,
      );
      addTearDown(provider.dispose);
      addTearDown(messaging.close);

      await provider.beginAuthenticatedSession();
      messaging.foregroundMessages.add(
        _message(
          _audience(staffUidA),
          type: 'normal',
          title: 'Account A alert',
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(provider.notifications, hasLength(1));
      expect(registerCalls, 1);
      expect(messaging.activeForegroundListeners, 1);
      expect(messaging.activeRefreshListeners, 1);

      await provider.endAuthenticatedSession();

      expect(unregisterCalls, 1);
      expect(messaging.deleteTokenCalls, 1);
      expect(messaging.activeForegroundListeners, 0);
      expect(messaging.activeRefreshListeners, 0);
      expect(provider.notifications, isEmpty);
      expect(provider.unreadCount, 0);

      messaging.token = 'fcm-token-b';
      activeStaffUid = staffUidB;
      await provider.initialize();
      expect(
        registerCalls,
        1,
        reason: 'logout must reject stale reinitialization',
      );
      await provider.beginAuthenticatedSession();

      expect(registerCalls, 2);
      expect(registeredTokens, ['fcm-token-a', 'fcm-token-b']);
      expect(messaging.activeForegroundListeners, 1);
      expect(messaging.activeRefreshListeners, 1);
    },
  );

  test('late account A fetch cannot repopulate state after teardown', () async {
    final messaging = _FakeNotificationMessaging();
    final fetched = Completer<List<dynamic>>();
    final provider = NotificationProvider(
      messaging: messaging,
      registerDevice: ({
        required fcmToken,
        required platform,
        required phone,
      }) async => _audience(staffUidA),
      unregisterDevice: () async {},
      phoneLoader: () async => null,
      staffUidLoader: () async => staffUidA,
      isAuthenticated: () async => true,
      notificationClaimsLoader: () async => _claims(staffUidA),
      notificationAuthorityValidator: (_) async => true,
      platformLoader: () => 'android',
      fetchNotifications: () => fetched.future,
      sessionStore: _testSessionStore(),
      clearDeliveredNotifications: () async {},
      supportsPush: true,
    );
    addTearDown(provider.dispose);
    addTearDown(messaging.close);

    await provider.initialize();
    final fetch = provider.fetchNotifications();
    final teardown = provider.endAuthenticatedSession();
    fetched.complete([
      {
        'id': 'account-a-alert',
        'title': 'Account A alert',
        'message': 'Do not retain',
      },
    ]);
    await Future.wait([fetch, teardown]);

    expect(provider.notifications, isEmpty);
    expect(provider.unreadCount, 0);
  });

  test('registration does not depend on an optional staff phone', () async {
    final messaging = _FakeNotificationMessaging();
    String? registeredPhone = 'not-called';
    final provider = NotificationProvider(
      messaging: messaging,
      registerDevice:
          ({required fcmToken, required platform, required phone}) async {
            registeredPhone = phone;
            return _audience(staffUidA);
          },
      unregisterDevice: () async {},
      phoneLoader: () async => null,
      staffUidLoader: () async => staffUidA,
      isAuthenticated: () async => true,
      notificationClaimsLoader: () async => _claims(staffUidA),
      notificationAuthorityValidator: (_) async => true,
      platformLoader: () => 'android',
      sessionStore: _testSessionStore(),
      clearDeliveredNotifications: () async {},
      supportsPush: true,
    );
    addTearDown(provider.dispose);
    addTearDown(messaging.close);

    await provider.initialize();

    expect(registeredPhone, isNull);
  });

  test(
    'registration failure keeps notification presentation inactive',
    () async {
      final messaging = _FakeNotificationMessaging();
      final sessionStore = _testSessionStore();
      final provider = NotificationProvider(
        messaging: messaging,
        registerDevice:
            ({required fcmToken, required platform, required phone}) async {
              throw StateError('backend ownership unavailable');
            },
        unregisterDevice: () async {},
        phoneLoader: () async => null,
        staffUidLoader: () async => staffUidA,
        isAuthenticated: () async => true,
        notificationClaimsLoader: () async => _claims(staffUidA),
        notificationAuthorityValidator: (_) async => true,
        platformLoader: () => 'android',
        sessionStore: sessionStore,
        clearDeliveredNotifications: () async {},
        supportsPush: true,
      );
      addTearDown(provider.dispose);
      addTearDown(messaging.close);

      await provider.beginAuthenticatedSession();

      expect(await sessionStore.isActiveFor(staffUidA), isFalse);
      expect(messaging.activeForegroundListeners, 0);
      expect(messaging.activeRefreshListeners, 0);
      expect(
        await mayPresentStaffPush(
          message: _message(_audience(staffUidA)),
          sessionStore: sessionStore,
          claimsLoader: () async => _claims(staffUidA),
          authorityValidator: (_) async => true,
        ),
        isFalse,
      );
    },
  );

  test(
    'durable marker authorizes only the staff UID that claimed it',
    () async {
      final sessionStore = _testSessionStore();
      await sessionStore.markActive(_audience(staffUidA));

      expect(
        await mayPresentStaffPush(
          message: _message(_audience(staffUidA)),
          sessionStore: sessionStore,
          claimsLoader: () async => _claims(staffUidA),
          authorityValidator: (_) async => true,
        ),
        isTrue,
      );
      expect(
        await mayPresentStaffPush(
          message: _message(_audience(staffUidB)),
          sessionStore: sessionStore,
          claimsLoader: () async => _claims(staffUidB),
          authorityValidator: (_) async => true,
        ),
        isFalse,
      );
    },
  );

  test('message gate fails closed for missing, expired, or server-revoked authority', () async {
    final sessionStore = _testSessionStore();
    final audience = _audience(staffUidA);
    await sessionStore.markActive(audience);

    expect(
      await mayPresentStaffPush(
        message: const RemoteMessage(data: {'type': 'code_blue'}),
        sessionStore: sessionStore,
        claimsLoader: () async => _claims(staffUidA),
        authorityValidator: (_) async => true,
      ),
      isFalse,
    );
    expect(
      await mayPresentStaffPush(
        message: _message(audience),
        sessionStore: sessionStore,
        claimsLoader: () async => StaffJwtClaims(
          staffUid: staffUidA,
          tenantId: tenantA,
          tokenEpoch: '4',
          sessionEpoch: 'session-family-1',
          expiresAt: DateTime.utc(2020),
        ),
        authorityValidator: (_) async => true,
      ),
      isFalse,
    );
    expect(
      await mayPresentStaffPush(
        message: _message(
          _audience(staffUidA, sessionEpoch: 'old-session-family'),
        ),
        sessionStore: sessionStore,
        claimsLoader: () async => _claims(staffUidA),
        authorityValidator: (_) async => true,
      ),
      isFalse,
    );
    expect(
      await mayPresentStaffPush(
        message: _message(audience),
        sessionStore: sessionStore,
        claimsLoader: () async => _claims(staffUidA),
        authorityValidator: (_) async => false,
      ),
      isFalse,
    );
  });

  test('listeners install only after backend ownership is claimed', () async {
    final messaging = _FakeNotificationMessaging();
    final sessionStore = _testSessionStore();
    final registrationStarted = Completer<void>();
    final releaseRegistration = Completer<void>();
    final provider = NotificationProvider(
      messaging: messaging,
      registerDevice:
          ({required fcmToken, required platform, required phone}) async {
            registrationStarted.complete();
            await releaseRegistration.future;
            return _audience(staffUidA);
          },
      unregisterDevice: () async {},
      phoneLoader: () async => null,
      staffUidLoader: () async => staffUidA,
      isAuthenticated: () async => true,
      notificationClaimsLoader: () async => _claims(staffUidA),
      notificationAuthorityValidator: (_) async => true,
      platformLoader: () => 'android',
      sessionStore: sessionStore,
      clearDeliveredNotifications: () async {},
      supportsPush: true,
    );
    addTearDown(provider.dispose);
    addTearDown(messaging.close);

    final initialization = provider.beginAuthenticatedSession();
    await registrationStarted.future;

    expect(await sessionStore.isActiveFor(staffUidA), isFalse);
    expect(messaging.activeForegroundListeners, 0);
    expect(messaging.activeRefreshListeners, 0);

    releaseRegistration.complete();
    await initialization;

    expect(await sessionStore.isActiveFor(staffUidA), isTrue);
    expect(messaging.activeForegroundListeners, 1);
    expect(messaging.activeRefreshListeners, 1);
  });

  test(
    'token refresh gates presentation until the new token is claimed',
    () async {
      final messaging = _FakeNotificationMessaging();
      final sessionStore = _testSessionStore();
      final refreshStarted = Completer<void>();
      final releaseRefresh = Completer<void>();
      var codeBlueDeliveries = 0;
      final provider = NotificationProvider(
        messaging: messaging,
        registerDevice:
            ({required fcmToken, required platform, required phone}) async {
              if (fcmToken == 'fcm-token-b') {
                refreshStarted.complete();
                await releaseRefresh.future;
              }
              return _audience(
                staffUidA,
                registrationEpoch: fcmToken == 'fcm-token-b' ? 2 : 1,
              );
            },
        unregisterDevice: () async {},
        phoneLoader: () async => null,
        staffUidLoader: () async => staffUidA,
        isAuthenticated: () async => true,
        notificationClaimsLoader: () async => _claims(staffUidA),
        notificationAuthorityValidator: (_) async => true,
        platformLoader: () => 'android',
        sessionStore: sessionStore,
        foregroundMessageHandler: (_) async {
          codeBlueDeliveries += 1;
        },
        clearDeliveredNotifications: () async {},
        supportsPush: true,
      );
      addTearDown(provider.dispose);
      addTearDown(messaging.close);

      await provider.beginAuthenticatedSession();
      expect(await sessionStore.isActiveFor(staffUidA), isTrue);

      messaging.refreshedTokens.add('fcm-token-b');
      await refreshStarted.future;
      expect(await sessionStore.isActiveFor(staffUidA), isFalse);

      messaging.foregroundMessages.add(_message(_audience(staffUidA)));
      await Future<void>.delayed(Duration.zero);
      expect(codeBlueDeliveries, 0);

      releaseRefresh.complete();
      await _waitUntil(() => sessionStore.isActiveFor(staffUidA));

      messaging.foregroundMessages.add(
        _message(_audience(staffUidA, registrationEpoch: 2)),
      );
      await Future<void>.delayed(Duration.zero);
      expect(codeBlueDeliveries, 1);
    },
  );

  test(
    'teardown waits for in-flight registration before unregistering',
    () async {
      final messaging = _FakeNotificationMessaging();
      final registrationStarted = Completer<void>();
      final releaseRegistration = Completer<void>();
      final events = <String>[];
      final provider = NotificationProvider(
        messaging: messaging,
        registerDevice:
            ({required fcmToken, required platform, required phone}) async {
              events.add('register-start');
              registrationStarted.complete();
              await releaseRegistration.future;
              events.add('register-end');
              return _audience(staffUidA);
            },
        unregisterDevice: () async => events.add('unregister'),
        phoneLoader: () async => '+919111111111',
        staffUidLoader: () async => staffUidA,
        isAuthenticated: () async => true,
        notificationClaimsLoader: () async => _claims(staffUidA),
        notificationAuthorityValidator: (_) async => true,
        platformLoader: () => 'android',
        sessionStore: _testSessionStore(),
        clearDeliveredNotifications: () async {},
        supportsPush: true,
      );
      addTearDown(provider.dispose);
      addTearDown(messaging.close);

      final initialize = provider.initialize();
      await registrationStarted.future;
      final teardown = provider.endAuthenticatedSession();
      await Future<void>.delayed(Duration.zero);
      expect(events, ['register-start']);

      releaseRegistration.complete();
      await Future.wait([initialize, teardown]);

      expect(events, ['register-start', 'register-end', 'unregister']);
      expect(provider.notifications, isEmpty);
      expect(messaging.activeForegroundListeners, 0);
    },
  );

  test('forced teardown without a loaded token fails closed when token deletion fails', () async {
    final messaging = _FakeNotificationMessaging(
      token: null,
      deleteTokenError: StateError('firebase unavailable'),
    );
    final persistence = _FakeSessionPersistence();
    final sessionStore = StaffNotificationSessionStore(
      persistence: persistence,
    );
    var surfaceCleanupCalls = 0;
    final provider = NotificationProvider(
      messaging: messaging,
      registerDevice: ({
        required fcmToken,
        required platform,
        required phone,
      }) async => _audience(staffUidA),
      unregisterDevice: () async {},
      phoneLoader: () async => null,
      staffUidLoader: () async => staffUidA,
      isAuthenticated: () async => true,
      notificationClaimsLoader: () async => _claims(staffUidA),
      notificationAuthorityValidator: (_) async => true,
      platformLoader: () => 'android',
      sessionStore: sessionStore,
      clearDeliveredNotifications: () async {
        surfaceCleanupCalls += 1;
      },
      supportsPush: true,
    );
    addTearDown(provider.dispose);
    addTearDown(messaging.close);

    await provider.beginAuthenticatedSession();
    expect(await sessionStore.isActiveFor(staffUidA), isFalse);

    await expectLater(
      provider.endAuthenticatedSession(unregisterBackend: false),
      throwsA(isA<StateError>()),
    );

    expect(messaging.deleteTokenCalls, 1);
    expect(surfaceCleanupCalls, 1);
    expect(await sessionStore.isActiveFor(staffUidA), isFalse);
    expect(messaging.activeForegroundListeners, 0);
    expect(messaging.activeRefreshListeners, 0);
  });

  test(
    'durable inactive marker survives restart until account B registers',
    () async {
      final persistence = _FakeSessionPersistence();
      final sessionStore = StaffNotificationSessionStore(
        persistence: persistence,
      );
      final accountAMessaging = _FakeNotificationMessaging(
        token: null,
        deleteTokenError: StateError('firebase unavailable'),
      );
      final accountA = NotificationProvider(
        messaging: accountAMessaging,
        registerDevice: ({
          required fcmToken,
          required platform,
          required phone,
        }) async => _audience(staffUidA),
        unregisterDevice: () async {},
        phoneLoader: () async => null,
        staffUidLoader: () async => staffUidA,
        isAuthenticated: () async => true,
        notificationClaimsLoader: () async => _claims(staffUidA),
        notificationAuthorityValidator: (_) async => true,
        platformLoader: () => 'android',
        sessionStore: sessionStore,
        clearDeliveredNotifications: () async {},
        supportsPush: true,
      );

      await accountA.beginAuthenticatedSession();
      await expectLater(
        accountA.endAuthenticatedSession(unregisterBackend: false),
        throwsA(isA<StateError>()),
      );
      accountA.dispose();
      await accountAMessaging.close();

      final restartedStore = StaffNotificationSessionStore(
        persistence: persistence,
      );
      expect(await restartedStore.isActiveFor(staffUidA), isFalse);
      expect(
        await mayPresentStaffPush(
          message: _message(_audience(staffUidA)),
          sessionStore: restartedStore,
          claimsLoader: () async => _claims(staffUidA),
          authorityValidator: (_) async => true,
        ),
        isFalse,
      );

      var accountBRegistrations = 0;
      var accountBDeliveries = 0;
      final accountBMessaging = _FakeNotificationMessaging(
        token: 'fcm-token-b',
      );
      final accountB = NotificationProvider(
        messaging: accountBMessaging,
        registerDevice:
            ({required fcmToken, required platform, required phone}) async {
              accountBRegistrations += 1;
              return _audience(staffUidB);
            },
        unregisterDevice: () async {},
        phoneLoader: () async => null,
        staffUidLoader: () async => staffUidB,
        isAuthenticated: () async => true,
        notificationClaimsLoader: () async => _claims(staffUidB),
        notificationAuthorityValidator: (_) async => true,
        platformLoader: () => 'android',
        sessionStore: restartedStore,
        foregroundMessageHandler: (_) async {
          accountBDeliveries += 1;
        },
        clearDeliveredNotifications: () async {},
        supportsPush: true,
      );
      addTearDown(accountB.dispose);
      addTearDown(accountBMessaging.close);

      await accountB.beginAuthenticatedSession();

      expect(accountBRegistrations, 1);
      expect(await restartedStore.isActiveFor(staffUidB), isTrue);
      accountBMessaging.foregroundMessages.add(_message(_audience(staffUidA)));
      await Future<void>.delayed(Duration.zero);
      expect(accountBDeliveries, 0);
      accountBMessaging.foregroundMessages.add(_message(_audience(staffUidB)));
      await Future<void>.delayed(Duration.zero);
      expect(accountBDeliveries, 1);
      expect(
        await mayPresentStaffPush(
          message: _message(_audience(staffUidB)),
          sessionStore: restartedStore,
          claimsLoader: () async => _claims(staffUidB),
          authorityValidator: (_) async => true,
        ),
        isTrue,
      );
    },
  );

  test(
    'teardown cancels posted Code Blue surfaces and owns the sole FCM listener',
    () async {
      final messaging = _FakeNotificationMessaging();
      var codeBlueDeliveries = 0;
      var postedCodeBlue = false;
      var surfaceCleanupCalls = 0;
      final provider = NotificationProvider(
        messaging: messaging,
        registerDevice: ({
          required fcmToken,
          required platform,
          required phone,
        }) async => _audience(staffUidA),
        unregisterDevice: () async {},
        phoneLoader: () async => null,
        staffUidLoader: () async => staffUidA,
        isAuthenticated: () async => true,
        notificationClaimsLoader: () async => _claims(staffUidA),
        notificationAuthorityValidator: (_) async => true,
        platformLoader: () => 'android',
        sessionStore: _testSessionStore(),
        foregroundMessageHandler: (message) async {
          if (message.data['type'] == 'code_blue') {
            codeBlueDeliveries += 1;
            postedCodeBlue = true;
          }
        },
        clearDeliveredNotifications: () async {
          surfaceCleanupCalls += 1;
          postedCodeBlue = false;
        },
        supportsPush: true,
      );
      addTearDown(provider.dispose);
      addTearDown(messaging.close);

      await provider.beginAuthenticatedSession();
      expect(messaging.activeForegroundListeners, 1);
      messaging.foregroundMessages.add(_message(_audience(staffUidA)));
      await Future<void>.delayed(Duration.zero);
      expect(codeBlueDeliveries, 1);
      expect(postedCodeBlue, isTrue);

      await provider.endAuthenticatedSession(unregisterBackend: false);

      expect(surfaceCleanupCalls, 1);
      expect(postedCodeBlue, isFalse);
      expect(messaging.activeForegroundListeners, 0);
      messaging.foregroundMessages.add(_message(_audience(staffUidA)));
      await Future<void>.delayed(Duration.zero);
      expect(codeBlueDeliveries, 1);
    },
  );

  test(
    'teardown completes state cleanup when listener cancellation throws',
    () async {
      final messaging = _FakeNotificationMessaging(
        foregroundCancelError: StateError('foreground cancel failed'),
        refreshCancelError: StateError('refresh cancel failed'),
      );
      final sessionStore = _testSessionStore();
      var registrations = 0;
      var unregistrations = 0;
      var surfaceCleanupCalls = 0;
      final provider = NotificationProvider(
        messaging: messaging,
        registerDevice:
            ({required fcmToken, required platform, required phone}) async {
              registrations += 1;
              return _audience(staffUidA);
            },
        unregisterDevice: () async => unregistrations += 1,
        phoneLoader: () async => null,
        staffUidLoader: () async => staffUidA,
        isAuthenticated: () async => true,
        notificationClaimsLoader: () async => _claims(staffUidA),
        notificationAuthorityValidator: (_) async => true,
        platformLoader: () => 'android',
        sessionStore: sessionStore,
        clearDeliveredNotifications: () async {
          surfaceCleanupCalls += 1;
        },
        supportsPush: true,
      );
      addTearDown(provider.dispose);
      addTearDown(messaging.close);

      await provider.beginAuthenticatedSession();
      expect(messaging.activeForegroundListeners, 1);
      expect(messaging.activeRefreshListeners, 1);

      await expectLater(
        provider.endAuthenticatedSession(),
        throwsA(isA<StateError>()),
      );

      expect(messaging.activeForegroundListeners, 0);
      expect(messaging.activeRefreshListeners, 0);
      expect(unregistrations, 1);
      expect(messaging.deleteTokenCalls, 1);
      expect(surfaceCleanupCalls, 1);
      expect(await sessionStore.isActiveFor(staffUidA), isFalse);

      await provider.beginAuthenticatedSession();
      expect(registrations, 2);
      expect(messaging.activeForegroundListeners, 1);
      expect(messaging.activeRefreshListeners, 1);
    },
  );
}

class _FakeNotificationMessaging implements NotificationMessaging {
  _FakeNotificationMessaging({
    this.token = 'fcm-token-a',
    this.deleteTokenError,
    Object? foregroundCancelError,
    Object? refreshCancelError,
  }) : foregroundMessages = _TrackedController<RemoteMessage>(
         cancelError: foregroundCancelError,
       ),
       refreshedTokens = _TrackedController<String>(
         cancelError: refreshCancelError,
       );

  final _TrackedController<RemoteMessage> foregroundMessages;
  final _TrackedController<String> refreshedTokens;
  String? token;
  final Object? deleteTokenError;
  int deleteTokenCalls = 0;

  int get activeForegroundListeners => foregroundMessages.activeListeners;
  int get activeRefreshListeners => refreshedTokens.activeListeners;

  @override
  Stream<RemoteMessage> get onMessage => foregroundMessages.stream;

  @override
  Stream<String> get onTokenRefresh => refreshedTokens.stream;

  @override
  Future<AuthorizationStatus> requestPermission() async =>
      AuthorizationStatus.authorized;

  @override
  Future<String?> getToken() async => token;

  @override
  Future<void> deleteToken() async {
    deleteTokenCalls += 1;
    if (deleteTokenError case final error?) throw error;
  }

  Future<void> close() async {
    await foregroundMessages.close();
    await refreshedTokens.close();
  }
}

class _FakeSessionPersistence implements NotificationSessionPersistence {
  final Map<String, String> values = {};

  @override
  Future<void> delete(String key) async => values.remove(key);

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

StaffNotificationSessionStore _testSessionStore() =>
    StaffNotificationSessionStore(persistence: _FakeSessionPersistence());

Future<void> _waitUntil(Future<bool> Function() predicate) async {
  for (var attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
  fail('condition did not become true');
}

class _TrackedController<T> {
  _TrackedController({this.cancelError});

  final Object? cancelError;
  int activeListeners = 0;
  bool _cancelErrorThrown = false;
  late final StreamController<T> _controller = StreamController<T>.broadcast(
    onListen: () => activeListeners += 1,
    onCancel: () => activeListeners -= 1,
  );

  Stream<T> get stream =>
      _ThrowingCancelStream<T>(_controller.stream, _takeCancelError);
  void add(T event) => _controller.add(event);
  Future<void> close() => _controller.close();

  Object? _takeCancelError() {
    final error = cancelError;
    if (_cancelErrorThrown || error == null) return null;
    _cancelErrorThrown = true;
    return error;
  }
}

class _ThrowingCancelStream<T> extends Stream<T> {
  const _ThrowingCancelStream(this._delegate, this._takeCancelError);

  final Stream<T> _delegate;
  final Object? Function() _takeCancelError;

  @override
  StreamSubscription<T> listen(
    void Function(T event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => _ThrowingCancelSubscription<T>(
    _delegate.listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    ),
    _takeCancelError,
  );
}

class _ThrowingCancelSubscription<T> implements StreamSubscription<T> {
  const _ThrowingCancelSubscription(this._delegate, this._takeCancelError);

  final StreamSubscription<T> _delegate;
  final Object? Function() _takeCancelError;

  @override
  Future<void> cancel() async {
    await _delegate.cancel();
    final error = _takeCancelError();
    if (error != null) throw error;
  }

  @override
  void onData(void Function(T data)? handleData) =>
      _delegate.onData(handleData);

  @override
  void onError(Function? handleError) => _delegate.onError(handleError);

  @override
  void onDone(void Function()? handleDone) => _delegate.onDone(handleDone);

  @override
  void pause([Future<void>? resumeSignal]) => _delegate.pause(resumeSignal);

  @override
  void resume() => _delegate.resume();

  @override
  bool get isPaused => _delegate.isPaused;

  @override
  Future<E> asFuture<E>([E? futureValue]) => _delegate.asFuture(futureValue);
}
