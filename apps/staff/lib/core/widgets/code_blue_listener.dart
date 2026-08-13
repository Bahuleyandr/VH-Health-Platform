import 'dart:async';
import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth_core/services/realtime_client.dart' show RealtimeEvent;

import '../../l10n/app_strings.dart';
import '../providers/websocket_provider.dart';

/// Invisible overlay widget that listens to `staff:code-blue` events and shows
/// a blocking full-screen modal the moment a Code Blue fires. Mount exactly
/// once above the router so route transitions cannot create overlapping
/// subscriptions.
///
/// The underlying channel subscription belongs to [WebSocketProvider], the
/// app's session-scoped realtime adapter. This listener only owns presentation
/// and cancels its relay subscription as soon as that authenticated session
/// ends.
typedef CodeBlueNotificationPresenter =
    Future<void> Function(Map<String, dynamic> data);
typedef CodeBlueDialogPresenter =
    CodeBluePresentation Function(BuildContext context, RealtimeEvent event);

abstract interface class CodeBluePresentation {
  Future<void> get completed;

  void dismiss();
}

class CodeBlueListener extends StatefulWidget {
  const CodeBlueListener({
    super.key,
    required this.child,
    required this.notificationPresenter,
    this.navigatorKey,
    this.dialogPresenter,
  });

  final Widget child;
  final GlobalKey<NavigatorState>? navigatorKey;
  final CodeBlueNotificationPresenter notificationPresenter;
  final CodeBlueDialogPresenter? dialogPresenter;

  @override
  State<CodeBlueListener> createState() => _CodeBlueListenerState();
}

class _CodeBlueListenerState extends State<CodeBlueListener> {
  static const int _maxRememberedEventIds = 256;

  final Queue<RealtimeEvent> _pendingDialogs = Queue<RealtimeEvent>();
  final LinkedHashSet<String> _seenEventIds = LinkedHashSet<String>();
  WebSocketProvider? _webSocketProvider;
  StreamSubscription<RealtimeEvent>? _codeBlueSub;
  int _subscriptionGeneration = 0;
  bool _dialogOpen = false;
  bool _dialogDismissPending = false;
  CodeBluePresentation? _activePresentation;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = context.read<WebSocketProvider>();
    if (identical(provider, _webSocketProvider)) return;

    _webSocketProvider?.removeListener(_syncSessionSubscription);
    _cancelSessionSubscription(clearPresentation: true);
    _webSocketProvider = provider..addListener(_syncSessionSubscription);
    _syncSessionSubscription();
  }

  void _syncSessionSubscription() {
    if (!mounted) return;
    final provider = _webSocketProvider;
    if (provider == null || !provider.hasAuthenticatedSession) {
      _cancelSessionSubscription(clearPresentation: true);
      return;
    }
    if (_codeBlueSub != null) return;

    final generation = ++_subscriptionGeneration;
    _codeBlueSub = provider.codeBlueEvents.listen((event) {
      if (!mounted ||
          generation != _subscriptionGeneration ||
          !provider.hasAuthenticatedSession) {
        return;
      }
      _onCodeBlue(event);
    });
  }

  void _onCodeBlue(RealtimeEvent event) {
    final eventId = _eventId(event.data);
    if (eventId != null && !_rememberEventId(eventId)) return;

    unawaited(_presentNotification(event.data));
    _pendingDialogs.addLast(event);
    _showNextDialog();
  }

  String? _eventId(Map<String, dynamic> data) {
    final value = data['eventId'] ?? data['event_id'];
    final normalized = value?.toString().trim();
    if (normalized == null || normalized.isEmpty || normalized == 'null') {
      return null;
    }
    return normalized;
  }

  bool _rememberEventId(String eventId) {
    if (!_seenEventIds.add(eventId)) return false;
    if (_seenEventIds.length > _maxRememberedEventIds) {
      _seenEventIds.remove(_seenEventIds.first);
    }
    return true;
  }

  Future<void> _presentNotification(Map<String, dynamic> data) async {
    try {
      await widget.notificationPresenter(data);
    } catch (error) {
      debugPrint('Code Blue notification presentation failed: $error');
    }
  }

  void _showNextDialog() {
    if (_dialogOpen || !mounted || _pendingDialogs.isEmpty) return;
    if (!(_webSocketProvider?.hasAuthenticatedSession ?? false)) return;

    final event = _pendingDialogs.removeFirst();
    _dialogOpen = true;
    _dialogDismissPending = false;
    final presentation = (widget.dialogPresenter ?? _presentDialog)(
      context,
      event,
    );
    _activePresentation = presentation;
    unawaited(
      presentation.completed.whenComplete(() {
        if (!identical(_activePresentation, presentation)) return;
        _activePresentation = null;
        _dialogOpen = false;
        _dialogDismissPending = false;
        if (mounted && (_webSocketProvider?.hasAuthenticatedSession ?? false)) {
          _showNextDialog();
        }
      }),
    );
  }

  CodeBluePresentation _presentDialog(
    BuildContext context,
    RealtimeEvent event,
  ) {
    final presentation = _NavigatorCodeBluePresentation();
    final dialogHost = widget.navigatorKey?.currentContext ?? context;
    final dialog = showDialog<void>(
      context: dialogHost,
      barrierDismissible: false,
      useRootNavigator: true,
      builder: (ctx) {
        presentation.attach(Navigator.of(ctx), ModalRoute.of<void>(ctx));
        final s = AppStrings.of(ctx);
        return AlertDialog(
          backgroundColor: Colors.red.shade900,
          titlePadding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          title: Row(
            children: [
              const Icon(Icons.emergency, color: Colors.white, size: 32),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  s.codeBlueTitle,
                  style: Theme.of(ctx).textTheme.headlineSmall?.copyWith(
                    color: Colors.white,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 2,
                  ),
                ),
              ),
            ],
          ),
          content: DefaultTextStyle(
            style: const TextStyle(color: Colors.white, fontSize: 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (event.data['ward'] != null)
                  Text('${s.codeBlueWardPrefix} ${event.data['ward']}'),
                if (event.data['bedNumber'] != null)
                  Text('${s.codeBlueBedPrefix} ${event.data['bedNumber']}'),
                Text(
                  '${s.codeBluePatientPrefix} ${event.data['patientId'] ?? '—'}',
                ),
                if (event.data['reason'] != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    '${event.data['reason']}',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ],
                const SizedBox(height: 12),
                Text(
                  s.codeBlueRespond,
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 14,
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              style: TextButton.styleFrom(
                foregroundColor: Colors.white,
                backgroundColor: Colors.red.shade700,
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 12,
                ),
              ),
              onPressed: () => Navigator.of(ctx).pop(),
              child: Text(
                s.codeBlueAcknowledge,
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
            ),
          ],
        );
      },
    );
    presentation.bind(dialog);
    return presentation;
  }

  void _cancelSessionSubscription({required bool clearPresentation}) {
    _subscriptionGeneration += 1;
    final subscription = _codeBlueSub;
    _codeBlueSub = null;
    if (subscription != null) {
      unawaited(_cancelQuietly(subscription));
    }
    if (!clearPresentation) return;

    _pendingDialogs.clear();
    _seenEventIds.clear();
    if (!_dialogOpen || _dialogDismissPending) return;
    _dialogDismissPending = true;
    _activePresentation?.dismiss();
  }

  Future<void> _cancelQuietly(
    StreamSubscription<RealtimeEvent> subscription,
  ) async {
    try {
      await subscription.cancel();
    } catch (error) {
      debugPrint('Code Blue relay subscription cleanup failed: $error');
    }
  }

  @override
  void dispose() {
    _webSocketProvider?.removeListener(_syncSessionSubscription);
    _cancelSessionSubscription(clearPresentation: false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class _NavigatorCodeBluePresentation implements CodeBluePresentation {
  final Completer<void> _completed = Completer<void>();
  NavigatorState? _navigator;
  ModalRoute<void>? _route;
  bool _dismissRequested = false;
  bool _dismissScheduled = false;

  @override
  Future<void> get completed => _completed.future;

  void bind(Future<void> dialog) {
    unawaited(
      dialog.whenComplete(() {
        if (!_completed.isCompleted) _completed.complete();
      }),
    );
  }

  void attach(NavigatorState navigator, ModalRoute<void>? route) {
    _navigator = navigator;
    _route = route;
    if (_dismissRequested) _removeRouteWhenSafe();
  }

  @override
  void dismiss() {
    _dismissRequested = true;
    _removeRouteWhenSafe();
  }

  void _removeRouteWhenSafe() {
    final navigator = _navigator;
    final route = _route;
    if (_dismissScheduled ||
        navigator == null ||
        route == null ||
        !route.isActive) {
      return;
    }
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.idle) {
      navigator.removeRoute(route);
      return;
    }
    _dismissScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _dismissScheduled = false;
      if (_dismissRequested && route.isActive) navigator.removeRoute(route);
    });
  }
}
