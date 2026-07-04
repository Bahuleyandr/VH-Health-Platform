import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/features/dashboard/providers/dashboard_provider.dart';
import 'package:vhhealth_core/models/api_response.dart';

void main() {
  test(
    'WebSocket appointment event invalidates and refreshes appointments',
    () async {
      final invalidated = <String>[];
      final fetched = <String>[];
      final fetchedCompleter = Completer<void>();
      final provider = DashboardProvider(
        isGuestSession: false,
        uidProvider: () => 'uid-1',
        invalidateCache: (path) async => invalidated.add(path),
        cachedGet: (path, {timeout, cacheTtl}) async {
          fetched.add(path);
          if (!fetchedCompleter.isCompleted) fetchedCompleter.complete();
          return _cachedAppointments([
            _appointment(id: 17, status: 'CONFIRMED'),
          ]);
        },
      );
      addTearDown(provider.dispose);

      final ws = _FakeWebSocketProvider();
      provider.attachWebSocketProvider(ws);

      ws.emitAppointmentEvent({'appointment_id': 17});
      await fetchedCompleter.future;
      await Future<void>.delayed(Duration.zero);

      expect(invalidated, ['/appointments/uid/uid-1']);
      expect(fetched, ['/appointments/uid/uid-1']);
      expect(provider.todayAppointment?['id'], 17);
      expect(ws.lastAppointmentEvent, isNull);
    },
  );

  test('cached offline appointment data is applied', () async {
    final fetched = <String>[];
    final provider = DashboardProvider(
      isGuestSession: false,
      uidProvider: () => 'uid-1',
      cachedGet: (path, {timeout, cacheTtl}) async {
        fetched.add(path);
        return _cachedAppointments(
          [_appointment(id: 24, status: 'CONFIRMED')],
          fromCache: true,
          staleLabel: '2 hours ago',
        );
      },
    );
    addTearDown(provider.dispose);

    await provider.refreshAppointments();

    expect(fetched, ['/appointments/uid/uid-1']);
    expect(provider.todayAppointment?['id'], 24);
  });
}

class _FakeWebSocketProvider extends WebSocketProvider {
  Map<String, dynamic>? _event;

  @override
  Map<String, dynamic>? get lastAppointmentEvent => _event;

  @override
  void clearAppointmentEvent() {
    _event = null;
  }

  void emitAppointmentEvent(Map<String, dynamic> data) {
    _event = data;
    notifyListeners();
  }
}

CachedApiResponse _cachedAppointments(
  List<Map<String, dynamic>> appointments, {
  bool fromCache = false,
  String? staleLabel,
}) {
  return CachedApiResponse(
    response: ApiResponse(
      statusCode: 200,
      isSuccess: true,
      data: appointments,
      raw: {'data': appointments},
    ),
    fromCache: fromCache,
    staleLabel: staleLabel,
  );
}

Map<String, dynamic> _appointment({required int id, required String status}) {
  final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
  return {
    'id': id,
    'status': status,
    'appointment_date': today,
    'appointment_time': '10:00',
    'doctor_name': 'Dr Rao',
  };
}
