import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import 'package:vhhealth_core/services/realtime_provider.dart';
import 'package:vhhealth_core/services/secure_storage.dart';

typedef PatientRealtimeUidReader = Future<String?> Function();

@visibleForTesting
abstract interface class PatientRealtimeBinding {
  void addListener(VoidCallback listener);
  void removeListener(VoidCallback listener);
  Future<void> ensureConnected();
  Stream<RealtimeEvent> events(String channel, {bool broadcastChannel = true});
  bool isSubscribed(String channel);
  void unsubscribe(String channel);
}

class _SharedRealtimeBinding implements PatientRealtimeBinding {
  const _SharedRealtimeBinding(this.provider);

  final RealtimeProvider provider;

  @override
  void addListener(VoidCallback listener) => provider.addListener(listener);

  @override
  void removeListener(VoidCallback listener) =>
      provider.removeListener(listener);

  @override
  Future<void> ensureConnected() => provider.ensureConnected();

  @override
  Stream<RealtimeEvent> events(
    String channel, {
    bool broadcastChannel = true,
  }) => provider.events(channel, broadcastChannel: broadcastChannel);

  @override
  bool isSubscribed(String channel) => provider.isSubscribed(channel);

  @override
  void unsubscribe(String channel) => provider.unsubscribe(channel);
}

/// Patient-specific bridge over the shared realtime fabric.
///
/// The app used to own a second WebSocket client that subscribed to staff-only
/// legacy channels before authentication completed. This provider now binds
/// the single shared [RealtimeProvider] to the two personal, acknowledged
/// patient channels keyed by the authenticated `patient_uid`.
class WebSocketProvider extends ChangeNotifier {
  WebSocketProvider({
    RealtimeProvider? realtimeProvider,
    @visibleForTesting PatientRealtimeBinding? realtimeBinding,
    PatientRealtimeUidReader? patientUidReader,
  }) : _realtime =
           realtimeBinding ??
           (realtimeProvider == null
               ? null
               : _SharedRealtimeBinding(realtimeProvider)),
       _patientUidReader =
           patientUidReader ??
           (() => VHSecureStorage.instance.read(key: 'firebase_uid')) {
    _realtime?.addListener(_handleRealtimeStateChanged);
  }

  final PatientRealtimeBinding? _realtime;
  final PatientRealtimeUidReader _patientUidReader;

  StreamSubscription<RealtimeEvent>? _appointmentSubscription;
  StreamSubscription<RealtimeEvent>? _queueSubscription;
  StreamSubscription<RealtimeEvent>? _notificationSubscription;
  Future<void>? _listenInFlight;
  String? _patientUid;
  String? _appointmentChannel;
  String? _queueChannel;
  bool _listening = false;
  bool _disposed = false;
  bool _appointmentAcknowledged = false;

  Map<String, dynamic>? _lastAppointmentEvent;
  Map<String, dynamic>? get lastAppointmentEvent => _lastAppointmentEvent;

  /// Monotonic event version so multiple consumers can react independently.
  /// Clearing a shared payload inside the first listener used to make later
  /// listeners miss the same appointment update.
  int _appointmentEventRevision = 0;
  int get appointmentEventRevision => _appointmentEventRevision;

  bool get isAppointmentSubscriptionAcknowledged => _appointmentAcknowledged;

  /// Upper bound on locally buffered notification events. The buffer only
  /// exists to hand events to [NotificationProvider.mergeFromWebSocket], which
  /// drains it on every merge — this cap is the backstop that keeps an
  /// unwired (or slow-to-attach) consumer from letting it grow for the life
  /// of the session. Oldest events are dropped first; the badge consumer only
  /// counts entries, so dropping overflow loses nothing it needs.
  static const int maxBufferedNotifications = 100;

  final List<Map<String, dynamic>> _wsNotifications = [];
  List<Map<String, dynamic>> get wsNotifications =>
      List.unmodifiable(_wsNotifications);

  /// Bind the current signed-in patient and ensure the shared socket connects.
  /// Safe to call at startup, foreground resume, and after an in-process login.
  Future<void> listen() {
    final existing = _listenInFlight;
    if (existing != null) return existing;

    late final Future<void> tracked;
    tracked = _bindCurrentPatient().whenComplete(() {
      if (identical(_listenInFlight, tracked)) _listenInFlight = null;
    });
    _listenInFlight = tracked;
    return tracked;
  }

  Future<void> _bindCurrentPatient() async {
    final realtime = _realtime;
    if (realtime == null || _disposed) return;

    final uid = (await _patientUidReader())?.trim();
    if (_disposed) return;
    if (uid == null || uid.isEmpty) {
      await stop(unsubscribe: true);
      return;
    }

    if (!_listening || uid != _patientUid) {
      await stop(unsubscribe: true);
      if (_disposed) return;

      _patientUid = uid;
      _appointmentChannel = 'patient:$uid:appointments';
      _queueChannel = 'patient:$uid:queue';

      _appointmentSubscription = realtime
          .events(_appointmentChannel!)
          .listen(_onPatientEvent, onDone: _handleStreamDone);
      _queueSubscription = realtime
          .events(_queueChannel!)
          .listen(_onPatientEvent, onDone: _handleStreamDone);
      _notificationSubscription = realtime
          .events('notification', broadcastChannel: false)
          .listen(_onNotification, onDone: _handleStreamDone);
      _listening = true;
      _syncAcknowledgements();
    }

    await realtime.ensureConnected();
  }

  void _onPatientEvent(RealtimeEvent event) {
    _lastAppointmentEvent = <String, dynamic>{
      ...event.data,
      'realtimeChannel': event.channel,
    };
    _appointmentEventRevision += 1;
    notifyListeners();
  }

  void _onNotification(RealtimeEvent event) {
    _wsNotifications.add(event.data);
    if (_wsNotifications.length > maxBufferedNotifications) {
      _wsNotifications.removeRange(
        0,
        _wsNotifications.length - maxBufferedNotifications,
      );
    }
    notifyListeners();
  }

  void _handleRealtimeStateChanged() => _syncAcknowledgements();

  void _syncAcknowledgements() {
    final realtime = _realtime;
    final appointmentChannel = _appointmentChannel;
    final appointmentAcknowledged =
        realtime != null &&
        appointmentChannel != null &&
        realtime.isSubscribed(appointmentChannel);
    if (_appointmentAcknowledged == appointmentAcknowledged) {
      return;
    }
    _appointmentAcknowledged = appointmentAcknowledged;
    notifyListeners();
  }

  void _handleStreamDone() {
    _listening = false;
    _retirePatientState();
    _syncAcknowledgements();
  }

  void _retirePatientState() {
    final changed =
        _lastAppointmentEvent != null || _wsNotifications.isNotEmpty;
    _lastAppointmentEvent = null;
    _wsNotifications.clear();
    if (changed && !_disposed) notifyListeners();
  }

  /// Stop the app-level listeners. [unsubscribe] is used when identity changes;
  /// an app-background disconnect can skip frames because the shared provider
  /// immediately tears down the whole socket.
  Future<void> stop({bool unsubscribe = false}) async {
    final oldAppointmentChannel = _appointmentChannel;
    final oldQueueChannel = _queueChannel;
    _listening = false;
    await _appointmentSubscription?.cancel();
    await _queueSubscription?.cancel();
    await _notificationSubscription?.cancel();
    _appointmentSubscription = null;
    _queueSubscription = null;
    _notificationSubscription = null;
    if (unsubscribe) {
      if (oldAppointmentChannel != null) {
        _realtime?.unsubscribe(oldAppointmentChannel);
      }
      if (oldQueueChannel != null) {
        _realtime?.unsubscribe(oldQueueChannel);
      }
      _retirePatientState();
    }
    _patientUid = null;
    _appointmentChannel = null;
    _queueChannel = null;
    _appointmentAcknowledged = false;
  }

  void clearNotifications() {
    _wsNotifications.clear();
  }

  @override
  void dispose() {
    _disposed = true;
    _realtime?.removeListener(_handleRealtimeStateChanged);
    unawaited(stop());
    super.dispose();
  }
}
