import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth_core/services/realtime_client.dart';

void main() {
  test(
    'binds personal channels by patient uid and surfaces server acks',
    () async {
      final realtime = _FakeRealtimeBinding();
      final provider = WebSocketProvider(
        realtimeBinding: realtime,
        patientUidReader: () async => 'patient-uid-1',
      );
      addTearDown(provider.dispose);

      await provider.listen();

      expect(
        realtime.channels,
        containsAll(<String>{
          'patient:patient-uid-1:appointments',
          'patient:patient-uid-1:queue',
          'notification',
        }),
      );
      expect(realtime.broadcastFlags['notification'], isFalse);
      expect(provider.isAppointmentSubscriptionAcknowledged, isFalse);

      realtime.acknowledge('patient:patient-uid-1:appointments');
      expect(provider.isAppointmentSubscriptionAcknowledged, isTrue);

      realtime.emit('patient:patient-uid-1:appointments', {
        'appointmentId': '42',
        'status': 'CONFIRMED',
      });
      await Future<void>.delayed(Duration.zero);
      expect(provider.appointmentEventRevision, 1);
      expect(
        provider.lastAppointmentEvent,
        containsPair('appointmentId', '42'),
      );
    },
  );

  test(
    'identity change retires old personal channels before rebinding',
    () async {
      var uid = 'patient-uid-1';
      final realtime = _FakeRealtimeBinding();
      final provider = WebSocketProvider(
        realtimeBinding: realtime,
        patientUidReader: () async => uid,
      );
      addTearDown(provider.dispose);

      await provider.listen();
      realtime.emit('patient:patient-uid-1:appointments', {
        'appointmentId': 'old-appointment',
      });
      realtime.emit('notification', {'id': 'old-notification'});
      await Future<void>.delayed(Duration.zero);
      uid = 'patient-uid-2';
      await provider.listen();

      expect(realtime.unsubscribed, <String>[
        'patient:patient-uid-1:appointments',
        'patient:patient-uid-1:queue',
      ]);
      expect(realtime.channels, contains('patient:patient-uid-2:appointments'));
      expect(provider.lastAppointmentEvent, isNull);
      expect(provider.wsNotifications, isEmpty);
    },
  );
}

class _FakeRealtimeBinding extends ChangeNotifier
    implements PatientRealtimeBinding {
  final Map<String, StreamController<RealtimeEvent>> _controllers = {};
  final Set<String> _acknowledged = {};
  final Map<String, bool> broadcastFlags = {};
  final List<String> unsubscribed = [];

  Set<String> get channels => _controllers.keys.toSet();

  @override
  Future<void> ensureConnected() async {}

  @override
  Stream<RealtimeEvent> events(String channel, {bool broadcastChannel = true}) {
    broadcastFlags[channel] = broadcastChannel;
    return _controllers
        .putIfAbsent(channel, StreamController<RealtimeEvent>.broadcast)
        .stream;
  }

  @override
  bool isSubscribed(String channel) => _acknowledged.contains(channel);

  void acknowledge(String channel) {
    _acknowledged.add(channel);
    notifyListeners();
  }

  void emit(String channel, Map<String, dynamic> data) {
    _controllers[channel]?.add(
      RealtimeEvent(channel: channel, data: data, at: DateTime.now()),
    );
  }

  @override
  void unsubscribe(String channel) {
    unsubscribed.add(channel);
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
