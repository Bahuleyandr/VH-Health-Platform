import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/services/realtime_provider.dart';
import 'package:vhhealth_staff/core/providers/websocket_provider.dart';

class _FakeRealtimeProvider extends RealtimeProvider {
  final Map<String, _LateDeliveryStream> controllers = {};
  final List<String> requestedChannels = [];
  var ensureConnectedCalls = 0;

  @override
  bool get isConnected => true;

  @override
  Future<void> ensureConnected() async {
    ensureConnectedCalls++;
  }

  @override
  Stream<RealtimeEvent> events(String channel, {bool broadcastChannel = true}) {
    requestedChannels.add(channel);
    return controllers[channel] ??= _LateDeliveryStream();
  }

  Future<void> close() async {
    for (final controller in controllers.values) {
      await controller.close();
    }
  }
}

class _LateDeliveryStream extends Stream<RealtimeEvent> {
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

RealtimeEvent _event(String channel) {
  return RealtimeEvent(
    channel: channel,
    data: <String, dynamic>{'id': '$channel-1'},
    at: DateTime(2026, 7, 5),
  );
}

void main() {
  test(
    'dispose cancels realtime subscriptions and ignores late events',
    () async {
      final realtime = _FakeRealtimeProvider();
      final provider = WebSocketProvider();
      addTearDown(realtime.close);

      provider.bind(realtime);
      await provider.beginAuthenticatedSession();
      await Future<void>.delayed(Duration.zero);

      expect(
        realtime.requestedChannels,
        containsAll(<String>[
          'notification',
          'appointment-status-changed',
          'staff:appointments',
          'queue-updates',
          'staff:code-blue',
        ]),
      );
      expect(realtime.ensureConnectedCalls, 1);

      realtime.controllers['notification']!.add(_event('notification'));
      realtime.controllers['staff:appointments']!.add(
        _event('staff:appointments'),
      );
      realtime.controllers['queue-updates']!.add(_event('queue-updates'));
      await Future<void>.delayed(Duration.zero);

      expect(provider.notifications, hasLength(1));
      expect(provider.appointmentUpdates, hasLength(1));
      expect(provider.latestQueueUpdate, isNotNull);

      provider.dispose();
      await Future<void>.delayed(const Duration(milliseconds: 10));

      realtime.controllers['notification']!.deliverAfterCancellation(
        _event('notification'),
      );
      realtime.controllers['staff:appointments']!.deliverAfterCancellation(
        _event('staff:appointments'),
      );
      realtime.controllers['queue-updates']!.deliverAfterCancellation(
        _event('queue-updates'),
      );
      await Future<void>.delayed(Duration.zero);

      expect(provider.notifications, hasLength(1));
      expect(provider.appointmentUpdates, hasLength(1));
      expect(provider.latestQueueUpdate, isNotNull);
    },
  );

  test(
    'session teardown clears all state and rejects prior-session events',
    () async {
      final accountA = _FakeRealtimeProvider();
      final accountB = _FakeRealtimeProvider();
      final provider = WebSocketProvider();
      addTearDown(accountA.close);
      addTearDown(accountB.close);
      addTearDown(provider.dispose);
      var codeBlueDeliveries = 0;
      final codeBlueSubscription = provider.codeBlueEvents.listen(
        (_) => codeBlueDeliveries += 1,
      );
      addTearDown(codeBlueSubscription.cancel);

      provider.bind(accountA);
      await provider.beginAuthenticatedSession();
      accountA.controllers['notification']!.add(_event('notification'));
      accountA.controllers['staff:appointments']!.add(
        _event('staff:appointments'),
      );
      accountA.controllers['queue-updates']!.add(_event('queue-updates'));
      accountA.controllers['staff:code-blue']!.add(_event('staff:code-blue'));
      await Future<void>.delayed(Duration.zero);

      expect(provider.notifications, hasLength(1));
      expect(provider.appointmentUpdates, hasLength(1));
      expect(provider.latestQueueUpdate, isNotNull);
      expect(codeBlueDeliveries, 1);

      await provider.endAuthenticatedSession();

      expect(provider.hasAuthenticatedSession, isFalse);
      expect(provider.isConnected, isFalse);
      expect(provider.notifications, isEmpty);
      expect(provider.appointmentUpdates, isEmpty);
      expect(provider.latestQueueUpdate, isNull);

      provider.bind(accountB);
      await provider.beginAuthenticatedSession();
      accountA.controllers['notification']!.deliverAfterCancellation(
        _event('notification'),
      );
      accountA.controllers['staff:appointments']!.deliverAfterCancellation(
        _event('staff:appointments'),
      );
      accountA.controllers['queue-updates']!.deliverAfterCancellation(
        _event('queue-updates'),
      );
      accountA.controllers['staff:code-blue']!.deliverAfterCancellation(
        _event('staff:code-blue'),
      );
      accountB.controllers['notification']!.add(_event('notification'));
      await Future<void>.delayed(Duration.zero);

      expect(provider.notifications, hasLength(1));
      expect(provider.appointmentUpdates, isEmpty);
      expect(provider.latestQueueUpdate, isNull);
      expect(codeBlueDeliveries, 1);
    },
  );
}
