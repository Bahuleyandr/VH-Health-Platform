import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/services/realtime_provider.dart';
import 'package:vhhealth_staff/core/providers/websocket_provider.dart';

class _FakeRealtimeProvider extends RealtimeProvider {
  final Map<String, StreamController<RealtimeEvent>> controllers = {};
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
      await Future<void>.delayed(Duration.zero);

      expect(
        realtime.requestedChannels,
        containsAll(<String>[
          'notification',
          'appointment-status-changed',
          'staff:appointments',
          'queue-updates',
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

      realtime.controllers['notification']!.add(_event('notification'));
      realtime.controllers['staff:appointments']!.add(
        _event('staff:appointments'),
      );
      realtime.controllers['queue-updates']!.add(_event('queue-updates'));
      await Future<void>.delayed(Duration.zero);

      expect(provider.notifications, hasLength(1));
      expect(provider.appointmentUpdates, hasLength(1));
      expect(provider.latestQueueUpdate, isNotNull);
    },
  );
}
