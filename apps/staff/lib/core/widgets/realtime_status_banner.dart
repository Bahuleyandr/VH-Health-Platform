import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/realtime_client.dart';

import '../../l10n/app_strings.dart';
import '../theme/app_theme.dart';

/// Read surface over the realtime data plane for [RealtimeStatusBanner].
///
/// Production code uses [RealtimeStatusSource.shared] (the singleton
/// [RealtimeClient]); tests construct one around stream controllers since the
/// client itself has no public constructor.
class RealtimeStatusSource {
  const RealtimeStatusSource({
    required this.connectionStateOf,
    required this.connectionStateChanges,
    required this.deniedChannelsOf,
    required this.deniedChannelsChanges,
  });

  factory RealtimeStatusSource.shared() {
    final client = RealtimeClient.instance;
    return RealtimeStatusSource(
      connectionStateOf: () => client.connectionState,
      connectionStateChanges: client.onConnectionStateChange,
      deniedChannelsOf: () => client.deniedChannels,
      deniedChannelsChanges: client.onDeniedChannelsChange,
    );
  }

  final RealtimeConnectionState Function() connectionStateOf;
  final Stream<RealtimeConnectionState> connectionStateChanges;
  final Set<String> Function() deniedChannelsOf;
  final Stream<Set<String>> deniedChannelsChanges;
}

/// Visible degraded-realtime indicator for clinical boards (R15).
///
/// Renders nothing while the realtime fabric is connected and healthy.
/// Otherwise shows exactly one strip:
///  - amber "live updates paused / data may be stale" whenever the socket is
///    reconnecting or disconnected, or
///  - red [deniedMessageKey] when the socket is connected but the server
///    answered `subscribe-denied` for any of [watchChannels] (e.g.
///    `staff:code-blue` in the ward view) — previously Crashlytics-only.
class RealtimeStatusBanner extends StatefulWidget {
  const RealtimeStatusBanner({
    super.key,
    this.watchChannels = const <String>{},
    this.deniedMessageKey,
    this.margin = EdgeInsets.zero,
    this.source,
    this.fallbackPoll,
    this.fallbackInterval = const Duration(seconds: 30),
  });

  /// Channels whose server-side denial must be surfaced. Empty set means the
  /// banner only reflects transport state.
  final Set<String> watchChannels;

  /// AppStrings key shown when a watched channel is denied. Required for the
  /// denial strip to render.
  final String? deniedMessageKey;

  final EdgeInsetsGeometry margin;

  /// Test seam; defaults to the shared [RealtimeClient].
  final RealtimeStatusSource? source;

  /// Refresh callback used while realtime is unavailable or a watched channel
  /// is denied. Clinical boards keep their normal event-driven refresh while
  /// healthy and fall back to bounded polling only while live updates cannot
  /// be trusted.
  final Future<void> Function()? fallbackPoll;
  final Duration fallbackInterval;

  @override
  State<RealtimeStatusBanner> createState() => _RealtimeStatusBannerState();
}

class _RealtimeStatusBannerState extends State<RealtimeStatusBanner> {
  late final RealtimeStatusSource _source;
  late RealtimeConnectionState _state;
  late Set<String> _denied;
  StreamSubscription<RealtimeConnectionState>? _stateSub;
  StreamSubscription<Set<String>>? _deniedSub;
  Timer? _fallbackTimer;
  bool _fallbackPollInFlight = false;

  @override
  void initState() {
    super.initState();
    _source = widget.source ?? RealtimeStatusSource.shared();
    _state = _source.connectionStateOf();
    _denied = _source.deniedChannelsOf();
    _syncFallbackTimer();
    _stateSub = _source.connectionStateChanges.listen((state) {
      if (!mounted) return;
      setState(() => _state = state);
      _syncFallbackTimer();
    });
    _deniedSub = _source.deniedChannelsChanges.listen((denied) {
      if (!mounted) return;
      setState(() => _denied = denied);
      _syncFallbackTimer();
    });
  }

  @override
  void dispose() {
    _fallbackTimer?.cancel();
    _stateSub?.cancel();
    _deniedSub?.cancel();
    super.dispose();
  }

  bool get _transportDegraded => _state != RealtimeConnectionState.connected;

  void _syncFallbackTimer() {
    _fallbackTimer?.cancel();
    _fallbackTimer = null;
    if ((!_transportDegraded && !_hasWatchedChannelDenial) ||
        widget.fallbackPoll == null) {
      return;
    }
    _fallbackTimer = Timer.periodic(widget.fallbackInterval, (_) {
      if (!_fallbackPollInFlight) unawaited(_pollFallback());
    });
  }

  Future<void> _pollFallback() async {
    final poll = widget.fallbackPoll;
    if (poll == null || _fallbackPollInFlight) return;
    _fallbackPollInFlight = true;
    try {
      await poll();
    } catch (error) {
      debugPrint('Realtime fallback poll failed: $error');
    } finally {
      _fallbackPollInFlight = false;
    }
  }

  bool get _hasWatchedChannelDenial =>
      widget.watchChannels.any(_denied.contains);

  bool get _watchedChannelDenied =>
      widget.deniedMessageKey != null && _hasWatchedChannelDenial;

  @override
  Widget build(BuildContext context) {
    // While the transport is down the denial set is stale, so the transport
    // strip wins; a denial is only actionable on a live connection.
    if (_transportDegraded) {
      return _strip(
        icon: Icons.cloud_off_outlined,
        color: AppTheme.warningAmber,
        messageKey: 's4.lib.realtime_status.stale',
      );
    }
    if (_watchedChannelDenied) {
      return _strip(
        icon: Icons.notifications_off_outlined,
        color: AppTheme.errorRed,
        messageKey: widget.deniedMessageKey!,
      );
    }
    return const SizedBox.shrink();
  }

  Widget _strip({
    required IconData icon,
    required Color color,
    required String messageKey,
  }) {
    final message = AppStrings.of(context).lookup(messageKey);
    return Semantics(
      container: true,
      liveRegion: true,
      label: message,
      child: ExcludeSemantics(
        child: Container(
          margin: widget.margin,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: color.withValues(alpha: 0.4)),
          ),
          child: Row(
            children: [
              Icon(icon, size: 18, color: color),
              const SizedBox(width: 8),
              Expanded(
                child: AppText(
                  messageKey,
                  style: TextStyle(
                    color: color,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
