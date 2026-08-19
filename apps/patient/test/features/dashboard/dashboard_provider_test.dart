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

      expect(invalidated, ['/appointments/patient/uid-1']);
      expect(fetched, ['/appointments/patient/uid-1']);
      expect(provider.todayAppointment?['id'], 17);
      expect(ws.lastAppointmentEvent, isNotNull);
    },
  );

  test(
    'active dependent id keys the appointment feed over the guardian id',
    () async {
      final fetched = <String>[];
      String? activeDependentId = '77';
      final provider = DashboardProvider(
        isGuestSession: false,
        uidProvider: () => 'uid-1',
        activeDependentIdProvider: () => activeDependentId,
        cachedGet: (path, {timeout, cacheTtl}) async {
          fetched.add(path);
          return _cachedAppointments(const []);
        },
      );
      addTearDown(provider.dispose);

      // Guardian viewing a dependent → the DEPENDENT's feed (P4: the
      // guardian id 403'd under acting-as and silently emptied the feed).
      await provider.refreshAppointments();
      expect(fetched, ['/appointments/patient/77']);

      // Back on the guardian's own profile → the guardian's feed.
      activeDependentId = null;
      fetched.clear();
      await provider.refreshAppointments();
      expect(fetched, ['/appointments/patient/uid-1']);
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

    expect(fetched, ['/appointments/patient/uid-1']);
    expect(provider.todayAppointment?['id'], 24);
  });

  test(
    'fallback polling stops only after appointment channel acknowledgement',
    () async {
      final timers = <void Function()>[];
      final fetched = <String>[];
      var acknowledged = false;
      final provider = DashboardProvider(
        isGuestSession: false,
        uidProvider: () => 'uid-1',
        isAppointmentRealtimeReady: () => acknowledged,
        createTimer: (_, callback) {
          timers.add(callback);
          return _FakeTimer();
        },
        cachedGet: (path, {timeout, cacheTtl}) async {
          fetched.add(path);
          return _cachedAppointments(const []);
        },
        get: (_, {timeout}) async => ApiResponse(
          statusCode: 200,
          isSuccess: true,
          data: const <String, dynamic>{},
          raw: const <String, dynamic>{},
        ),
      );
      addTearDown(provider.dispose);

      provider.start();
      await Future<void>.delayed(Duration.zero);
      fetched.clear();

      timers.first();
      await Future<void>.delayed(Duration.zero);
      expect(fetched, ['/appointments/patient/uid-1']);

      acknowledged = true;
      fetched.clear();
      timers.last();
      await Future<void>.delayed(Duration.zero);
      expect(fetched, isEmpty);
    },
  );
}

class _FakeWebSocketProvider extends WebSocketProvider {
  Map<String, dynamic>? _event;
  int _revision = 0;

  @override
  Map<String, dynamic>? get lastAppointmentEvent => _event;

  @override
  int get appointmentEventRevision => _revision;

  void emitAppointmentEvent(Map<String, dynamic> data) {
    _event = data;
    _revision += 1;
    notifyListeners();
  }
}

class _FakeTimer implements Timer {
  var _active = true;

  @override
  void cancel() => _active = false;

  @override
  bool get isActive => _active;

  @override
  int get tick => 0;
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
