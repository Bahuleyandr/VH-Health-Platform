import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_device_service.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_room_client.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

class TeleconsultConsultScreen extends StatefulWidget {
  const TeleconsultConsultScreen({
    super.key,
    required this.appointment,
    required this.lobbyState,
    required this.readiness,
    this.repository = const TeleconsultRepository(),
    this.roomClient = const LiveKitTeleconsultRoomClient(),
  });

  final AppointmentInfo appointment;
  final TeleconsultLobbyState lobbyState;
  final TeleconsultDeviceReadiness readiness;
  final TeleconsultRepository repository;
  final TeleconsultRoomClient roomClient;

  @override
  State<TeleconsultConsultScreen> createState() =>
      _TeleconsultConsultScreenState();
}

class _TeleconsultConsultScreenState extends State<TeleconsultConsultScreen> {
  TeleconsultRoomSession? _session;
  Timer? _pollTimer;
  bool _joining = true;
  bool _joinFailed = false;
  bool _openingMessages = false;
  bool _terminal = false;
  bool _audioOnlyBanner = false;

  @override
  void initState() {
    super.initState();
    unawaited(_join());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    final session = _session;
    if (session != null) {
      unawaited(session.disconnect());
      session.dispose();
    }
    super.dispose();
  }

  Future<void> _join() async {
    final teleconsultationId = widget.lobbyState.teleconsultationId;
    if (teleconsultationId == null) {
      if (mounted) {
        setState(() {
          _joining = false;
          _joinFailed = true;
        });
      }
      return;
    }
    try {
      final token = await widget.repository.requestJoinToken(
        teleconsultationId,
      );
      final session = await widget.roomClient.connect(
        token: token,
        publishVideo:
            widget.readiness.kind == TeleconsultReadinessKind.videoReady,
      );
      if (!mounted) {
        await session.disconnect();
        return;
      }
      setState(() {
        _session = session;
        _joining = false;
        _joinFailed = false;
        _audioOnlyBanner =
            widget.readiness.kind ==
            TeleconsultReadinessKind.audioOnlyRecommended;
      });
      _pollTimer = Timer.periodic(
        const Duration(seconds: 30),
        (_) => unawaited(_pollLobbyState()),
      );
    } catch (e) {
      debugPrint('Teleconsult join failed: $e');
      if (!mounted) return;
      setState(() {
        _joining = false;
        _joinFailed = true;
      });
    }
  }

  Future<void> _pollLobbyState() async {
    try {
      final state = await widget.repository.fetchLobbyState(
        widget.appointment.id,
      );
      if (!mounted || !state.isTerminal) return;
      _pollTimer?.cancel();
      await _session?.disconnect();
      setState(() => _terminal = true);
    } catch (_) {
      // Poll failures should not drop an active consult.
    }
  }

  Future<void> _toggleMicrophone() async {
    final session = _session;
    if (session == null) return;
    await session.setMicrophoneEnabled(!session.microphoneEnabled);
  }

  Future<void> _toggleCamera() async {
    final session = _session;
    if (session == null) return;
    await session.setCameraEnabled(!session.cameraEnabled);
  }

  Future<void> _switchAudioOnly() async {
    final session = _session;
    if (session == null) return;
    await session.switchToAudioOnly();
    if (mounted) setState(() => _audioOnlyBanner = true);
  }

  Future<void> _openSecureMessages() async {
    final l = AppLocalizations.of(context)!;
    setState(() => _openingMessages = true);
    try {
      final threadId = await widget.repository.ensureSecureMessageFallback(
        appointmentId: widget.appointment.id,
        subject: l.teleconsultSecureMessageSubject,
        body: l.teleconsultSecureMessageBody,
      );
      if (!mounted) return;
      context.go('/portal/messages/$threadId');
    } catch (e) {
      if (!mounted) return;
      setState(() => _openingMessages = false);
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(message: l.teleconsultSecureMessagesFailed),
      );
    }
  }

  Future<void> _endCall() async {
    _pollTimer?.cancel();
    await _session?.disconnect();
    if (mounted) context.go('/appointments');
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final color = Theme.of(context).colorScheme.primary;
    return FeatureScreenScaffold(
      title: l.teleconsultConsultTitle,
      icon: Icons.video_call_outlined,
      color: color,
      child: _joining
          ? _ConnectingView(label: l.teleconsultConnecting)
          : _ConsultRoom(
              appointment: widget.appointment,
              session: _session,
              joinFailed: _joinFailed,
              terminal: _terminal,
              audioOnlyBanner: _audioOnlyBanner,
              openingMessages: _openingMessages,
              onToggleMic: _toggleMicrophone,
              onToggleCamera: _toggleCamera,
              onAudioOnly: _switchAudioOnly,
              onOpenMessages: _openSecureMessages,
              onEndCall: _endCall,
            ),
    );
  }
}

class _ConnectingView extends StatelessWidget {
  const _ConnectingView({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 16),
          Text(label),
        ],
      ),
    );
  }
}

class _ConsultRoom extends StatelessWidget {
  const _ConsultRoom({
    required this.appointment,
    required this.session,
    required this.joinFailed,
    required this.terminal,
    required this.audioOnlyBanner,
    required this.openingMessages,
    required this.onToggleMic,
    required this.onToggleCamera,
    required this.onAudioOnly,
    required this.onOpenMessages,
    required this.onEndCall,
  });

  final AppointmentInfo appointment;
  final TeleconsultRoomSession? session;
  final bool joinFailed;
  final bool terminal;
  final bool audioOnlyBanner;
  final bool openingMessages;
  final VoidCallback onToggleMic;
  final VoidCallback onToggleCamera;
  final VoidCallback onAudioOnly;
  final VoidCallback onOpenMessages;
  final VoidCallback onEndCall;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (joinFailed)
          _Banner(
            icon: Icons.warning_amber_outlined,
            text: l.teleconsultVideoUnavailableChatAvailable,
          )
        else if (terminal)
          _Banner(icon: Icons.event_busy_outlined, text: l.teleconsultCallEnded)
        else if (audioOnlyBanner)
          _Banner(
            icon: Icons.hearing_outlined,
            text: l.teleconsultAudioOnlyBanner,
          ),
        if (joinFailed || terminal || audioOnlyBanner)
          const SizedBox(height: 12),
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: ColoredBox(
              color: Colors.black,
              child: session == null
                  ? _VideoFallback(label: l.teleconsultRemoteVideo)
                  : AnimatedBuilder(
                      animation: session!,
                      builder: (context, _) => Stack(
                        children: [
                          Positioned.fill(
                            child: Semantics(
                              label: l.teleconsultRemoteVideo,
                              child: session!.buildRemoteVideo(context),
                            ),
                          ),
                          Positioned(
                            right: 12,
                            bottom: 12,
                            width: 108,
                            height: 144,
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                border: Border.all(color: Colors.white70),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                child: Semantics(
                                  label: l.teleconsultLocalVideo,
                                  child: session!.buildLocalVideo(context),
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
            ),
          ),
        ),
        const SizedBox(height: 12),
        if (session == null)
          _FallbackActions(
            openingMessages: openingMessages,
            onOpenMessages: onOpenMessages,
            onEndCall: onEndCall,
          )
        else
          AnimatedBuilder(
            animation: session!,
            builder: (context, _) => _RoomControls(
              session: session!,
              openingMessages: openingMessages,
              onToggleMic: onToggleMic,
              onToggleCamera: onToggleCamera,
              onAudioOnly: onAudioOnly,
              onOpenMessages: onOpenMessages,
              onEndCall: onEndCall,
            ),
          ),
      ],
    );
  }
}

class _RoomControls extends StatelessWidget {
  const _RoomControls({
    required this.session,
    required this.openingMessages,
    required this.onToggleMic,
    required this.onToggleCamera,
    required this.onAudioOnly,
    required this.onOpenMessages,
    required this.onEndCall,
  });

  final TeleconsultRoomSession session;
  final bool openingMessages;
  final VoidCallback onToggleMic;
  final VoidCallback onToggleCamera;
  final VoidCallback onAudioOnly;
  final VoidCallback onOpenMessages;
  final VoidCallback onEndCall;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Wrap(
      alignment: WrapAlignment.center,
      spacing: 8,
      runSpacing: 8,
      children: [
        IconButton.filledTonal(
          tooltip: session.microphoneEnabled
              ? l.teleconsultMicrophoneOn
              : l.teleconsultMicrophoneOff,
          onPressed: onToggleMic,
          icon: Icon(
            session.microphoneEnabled
                ? Icons.mic_outlined
                : Icons.mic_off_outlined,
          ),
        ),
        IconButton.filledTonal(
          tooltip: session.cameraEnabled
              ? l.teleconsultCameraOn
              : l.teleconsultCameraOff,
          onPressed: onToggleCamera,
          icon: Icon(
            session.cameraEnabled
                ? Icons.videocam_outlined
                : Icons.videocam_off_outlined,
          ),
        ),
        TextButton.icon(
          onPressed: onAudioOnly,
          icon: const Icon(Icons.hearing_outlined),
          label: Text(l.teleconsultSwitchAudioOnly),
        ),
        TextButton.icon(
          onPressed: openingMessages ? null : onOpenMessages,
          icon: openingMessages
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.chat_bubble_outline),
          label: Text(l.teleconsultOpenSecureMessages),
        ),
        FilledButton.icon(
          onPressed: onEndCall,
          icon: const Icon(Icons.call_end_outlined),
          label: Text(l.teleconsultEndCall),
        ),
      ],
    );
  }
}

class _FallbackActions extends StatelessWidget {
  const _FallbackActions({
    required this.openingMessages,
    required this.onOpenMessages,
    required this.onEndCall,
  });

  final bool openingMessages;
  final VoidCallback onOpenMessages;
  final VoidCallback onEndCall;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Wrap(
      alignment: WrapAlignment.center,
      spacing: 8,
      runSpacing: 8,
      children: [
        FilledButton.icon(
          onPressed: openingMessages ? null : onOpenMessages,
          icon: openingMessages
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.chat_bubble_outline),
          label: Text(l.teleconsultOpenSecureMessages),
        ),
        TextButton.icon(
          onPressed: onEndCall,
          icon: const Icon(Icons.close_outlined),
          label: Text(l.teleconsultEndCall),
        ),
      ],
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(icon, color: scheme.onSecondaryContainer),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: scheme.onSecondaryContainer),
            ),
          ),
        ],
      ),
    );
  }
}

class _VideoFallback extends StatelessWidget {
  const _VideoFallback({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            Icons.videocam_off_outlined,
            color: Colors.white,
            size: 40,
          ),
          const SizedBox(height: 8),
          Text(label, style: const TextStyle(color: Colors.white)),
        ],
      ),
    );
  }
}
