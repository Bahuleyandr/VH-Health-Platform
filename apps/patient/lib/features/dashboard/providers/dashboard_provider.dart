import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/websocket_service.dart';

typedef DashboardUidProvider = String? Function();
typedef DashboardWsConnected = bool Function();
typedef DashboardCacheInvalidator = Future<void> Function(String path);
typedef DashboardTimerFactory =
    Timer Function(Duration duration, void Function() callback);
typedef DashboardCachedGet =
    Future<CachedApiResponse> Function(
      String path, {
      Duration? timeout,
      Duration? cacheTtl,
    });
typedef DashboardGet =
    Future<ApiResponse> Function(String path, {Duration? timeout});

class DashboardProvider extends ChangeNotifier {
  DashboardProvider({
    required bool isGuestSession,
    DashboardUidProvider? uidProvider,
    DashboardCachedGet? cachedGet,
    DashboardGet? get,
    DashboardCacheInvalidator? invalidateCache,
    DashboardWsConnected? isWebSocketConnected,
    DashboardTimerFactory? createTimer,
    this.appointmentFallbackBase = const Duration(seconds: 120),
    this.smartPollBase = const Duration(seconds: 60),
  }) : _isGuestSession = isGuestSession,
       _uidProvider = uidProvider ?? _firebaseUid,
       _cachedGet = cachedGet ?? _defaultCachedGet,
       _get = get ?? _defaultGet,
       _invalidateCache = invalidateCache ?? ApiCacheManager.invalidate,
       _isWebSocketConnected =
           isWebSocketConnected ??
           (() => WebSocketService.instance.isConnected),
       _createTimer = createTimer ?? Timer.new;

  final bool _isGuestSession;
  final DashboardUidProvider _uidProvider;
  final DashboardCachedGet _cachedGet;
  final DashboardGet _get;
  final DashboardCacheInvalidator _invalidateCache;
  final DashboardWsConnected _isWebSocketConnected;
  final DashboardTimerFactory _createTimer;
  final Duration appointmentFallbackBase;
  final Duration smartPollBase;

  Timer? _appointmentPoller;
  Timer? _smartWidgetPoller;
  WebSocketProvider? _webSocketProvider;
  bool _started = false;
  bool _disposed = false;
  int _appointmentPollFailures = 0;
  int _smartPollFailures = 0;

  Map<String, dynamic>? _todayAppointment;
  Map<String, dynamic>? _nextAppointmentDetail;
  int? _wellnessScore;
  int? _stepsToday;
  int? _stepGoal;
  double? _distanceTodayMeters;
  String? _activityLevelLabel;

  Map<String, dynamic>? get todayAppointment => _todayAppointment;
  Map<String, dynamic>? get nextAppointmentDetail => _nextAppointmentDetail;
  int? get wellnessScore => _wellnessScore;
  int? get stepsToday => _stepsToday;
  int? get stepGoal => _stepGoal;
  double? get distanceTodayMeters => _distanceTodayMeters;
  String? get activityLevelLabel => _activityLevelLabel;

  void start() {
    if (_started || _isGuestSession) return;
    _started = true;
    unawaited(refreshAppointments());
    _scheduleNextAppointmentFallback();
    unawaited(refreshSmartWidgets());
    _scheduleNextSmartPoll();
  }

  void attachWebSocketProvider(WebSocketProvider provider) {
    if (identical(_webSocketProvider, provider)) return;
    _webSocketProvider?.removeListener(_handleAppointmentEvent);
    _webSocketProvider = provider..addListener(_handleAppointmentEvent);
    _handleAppointmentEvent();
  }

  Future<void> refreshAppointments({bool invalidateCache = false}) async {
    if (_isGuestSession || _disposed) return;
    try {
      final uid = _uidProvider();
      if (uid == null || uid.isEmpty) return;
      final path = _appointmentPath(uid);

      if (invalidateCache) {
        await _invalidateCache(path);
      }

      final result = await _cachedGet(
        path,
        timeout: const Duration(seconds: 8),
      );
      if (_disposed) return;

      if (result.isSuccess) {
        _applyAppointments(result.data);
        _appointmentPollFailures = 0;

        final freshFuture = result.onFresh;
        if (freshFuture != null) {
          unawaited(
            freshFuture
                .then((fresh) {
                  if (_disposed || !fresh.isSuccess) return;
                  _applyAppointments(fresh.data);
                })
                .catchError((Object e) {
                  if (kDebugMode) {
                    debugPrint('Appointment background refresh failed: $e');
                  }
                }),
          );
        }
      }
    } catch (e) {
      _appointmentPollFailures++;
      if (kDebugMode) {
        debugPrint(
          'Appointment refresh failed (#$_appointmentPollFailures): $e',
        );
      }
    }
  }

  Future<void> refreshSmartWidgets() async {
    if (_isGuestSession || _disposed) return;
    var hadSuccess = false;

    try {
      final wsRes = await _get(
        '/gamification/wellness-score',
        timeout: const Duration(seconds: 8),
      );
      if (!_disposed && wsRes.isSuccess) {
        hadSuccess = true;
        final data = wsRes.dataAsMap();
        final score = data['score'];
        if (score is num) {
          _wellnessScore = score.toInt();
          _notifySafely();
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('Smart poll (wellness) failed: $e');
    }

    try {
      final stepsRes = await _get(
        '/steps/profile',
        timeout: const Duration(seconds: 8),
      );
      if (!_disposed && stepsRes.isSuccess) {
        hadSuccess = true;
        final data = stepsRes.dataAsMap();
        final profile = data['profile'] is Map ? data['profile'] as Map : null;
        final todayActivity = data['todayActivity'] is Map
            ? data['todayActivity'] as Map
            : null;
        final activityLevel = data['activityLevel'] is Map
            ? data['activityLevel'] as Map
            : null;
        final today =
            data['steps_today'] ??
            data['stepsToday'] ??
            todayActivity?['steps'] ??
            data['today'];
        final goal =
            data['daily_goal'] ??
            data['dailyGoal'] ??
            data['goal'] ??
            profile?['daily_goal'] ??
            profile?['dailyGoal'];
        final distance =
            data['distanceTodayMeters'] ??
            data['distance_today_meters'] ??
            todayActivity?['distanceMeters'];
        final levelLabel =
            activityLevel?['label']?.toString() ??
            (todayActivity?['activityLevel'] is Map
                ? (todayActivity?['activityLevel'] as Map)['label']?.toString()
                : null);

        _stepsToday = today is num ? today.toInt() : _stepsToday;
        _stepGoal = goal is num ? goal.toInt() : _stepGoal;
        _distanceTodayMeters = distance is num
            ? distance.toDouble()
            : _distanceTodayMeters;
        _activityLevelLabel = levelLabel ?? _activityLevelLabel;
        _notifySafely();
      }
    } catch (e) {
      if (kDebugMode) debugPrint('Smart poll (steps) failed: $e');
    }

    if (hadSuccess) {
      _smartPollFailures = 0;
    } else {
      _smartPollFailures++;
      if (kDebugMode) {
        debugPrint('Smart poll failed (#$_smartPollFailures)');
      }
    }
  }

  void applyCommandCenterAppointment(
    Map<String, dynamic> appointment, {
    bool notify = true,
  }) {
    final next = appointment.isEmpty
        ? null
        : Map<String, dynamic>.from(appointment);
    _todayAppointment = next;
    _nextAppointmentDetail = next;
    if (notify) _notifySafely();
  }

  void clearProfileScopedState() {
    _todayAppointment = null;
    _nextAppointmentDetail = null;
    _wellnessScore = null;
    _stepsToday = null;
    _stepGoal = null;
    _distanceTodayMeters = null;
    _activityLevelLabel = null;
    _appointmentPollFailures = 0;
    _smartPollFailures = 0;
    _notifySafely();
  }

  void _handleAppointmentEvent() {
    if (_isGuestSession || _disposed) return;
    final event = _webSocketProvider?.lastAppointmentEvent;
    if (event == null) return;

    _webSocketProvider?.clearAppointmentEvent();
    unawaited(refreshAppointments(invalidateCache: true));
  }

  void _scheduleNextAppointmentFallback() {
    if (_isGuestSession || _disposed) return;
    final delay = _backoffDuration(
      appointmentFallbackBase,
      _appointmentPollFailures,
    );
    _appointmentPoller?.cancel();
    _appointmentPoller = _createTimer(delay, () {
      unawaited(() async {
        if (!_isWebSocketConnected()) {
          await refreshAppointments();
        }
        if (!_disposed) _scheduleNextAppointmentFallback();
      }());
    });
  }

  void _scheduleNextSmartPoll() {
    if (_isGuestSession || _disposed) return;
    final delay = _backoffDuration(smartPollBase, _smartPollFailures);
    _smartWidgetPoller?.cancel();
    _smartWidgetPoller = _createTimer(delay, () {
      unawaited(() async {
        await refreshSmartWidgets();
        if (!_disposed) _scheduleNextSmartPoll();
      }());
    });
  }

  void _applyAppointments(dynamic raw) {
    final appointments = _appointmentList(raw);
    final now = DateTime.now();
    final todayStr = DateFormat('yyyy-MM-dd').format(now);

    Map<String, dynamic>? todayAppt;
    for (final appt in appointments) {
      final dateStr = appt['appointment_date']?.toString() ?? '';
      if (dateStr.startsWith(todayStr)) {
        final status = appt['status']?.toString() ?? '';
        if (status != 'CANCELLED' && status != 'NO_SHOW') {
          todayAppt = appt;
          break;
        }
      }
    }

    _todayAppointment = todayAppt;
    _notifySafely();
  }

  void _notifySafely() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _appointmentPoller?.cancel();
    _smartWidgetPoller?.cancel();
    _webSocketProvider?.removeListener(_handleAppointmentEvent);
    super.dispose();
  }

  static String? _firebaseUid() => FirebaseAuth.instance.currentUser?.uid;

  static String _appointmentPath(String uid) => '/appointments/uid/$uid';

  static Future<CachedApiResponse> _defaultCachedGet(
    String path, {
    Duration? timeout,
    Duration? cacheTtl,
  }) {
    return ApiClient.cachedGet(
      path,
      timeout: timeout,
      cacheTtl: cacheTtl ?? ApiCacheManager.defaultTtl,
    );
  }

  static Future<ApiResponse> _defaultGet(String path, {Duration? timeout}) {
    return ApiClient.get(path, timeout: timeout);
  }

  static Duration _backoffDuration(Duration base, int failures) {
    if (failures <= 0) return base;
    final bounded = failures.clamp(0, 4).toInt();
    return base * (1 << bounded);
  }

  static List<Map<String, dynamic>> _appointmentList(dynamic raw) {
    final list = raw is List
        ? raw
        : raw is Map
        ? raw['appointments'] ?? raw['data'] ?? const []
        : const [];
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }
}
