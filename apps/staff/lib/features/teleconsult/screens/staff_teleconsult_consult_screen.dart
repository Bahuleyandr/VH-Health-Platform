import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../models/staff_teleconsult_models.dart';
import '../models/staff_teleconsult_route_args.dart';
import '../services/staff_teleconsult_repository.dart';
import '../services/staff_teleconsult_room_client.dart';
import '../widgets/staff_teleconsult_badge.dart';

class StaffTeleconsultConsultScreen extends StatefulWidget {
  const StaffTeleconsultConsultScreen({
    super.key,
    required this.appointment,
    this.repository = const StaffTeleconsultRepository(),
    this.roomClient = const LiveKitStaffTeleconsultRoomClient(),
  });

  final StaffTeleconsultAppointmentContext appointment;
  final StaffTeleconsultRepository repository;
  final StaffTeleconsultRoomClient roomClient;

  @override
  State<StaffTeleconsultConsultScreen> createState() =>
      _StaffTeleconsultConsultScreenState();
}

class _StaffTeleconsultConsultScreenState
    extends State<StaffTeleconsultConsultScreen> {
  StaffTeleconsultLobbyState? _state;
  StaffTeleconsultRoomSession? _session;
  String? _error;
  bool _joining = true;
  bool _ending = false;
  bool _ended = false;

  StaffTeleconsultAppointmentContext get _appointment => widget.appointment;

  @override
  void initState() {
    super.initState();
    _join();
  }

  @override
  void dispose() {
    final session = _session;
    session?.removeListener(_sessionChanged);
    if (session?.connected == true) {
      session?.disconnect();
    }
    session?.dispose();
    super.dispose();
  }

  Future<void> _join() async {
    setState(() {
      _joining = true;
      _error = null;
    });
    try {
      var teleconsultationId = _appointment.teleconsultationId;
      StaffTeleconsultLobbyState state;
      if (teleconsultationId == null) {
        state = await widget.repository.ensureForAppointment(
          _appointment.appointmentId,
        );
        teleconsultationId = state.teleconsultationId;
      } else {
        state = await widget.repository.fetchRoomState(teleconsultationId);
      }
      if (teleconsultationId == null) {
        throw const StaffTeleconsultRepositoryException(
          'Teleconsultation was not returned',
        );
      }
      if (!state.joinable) {
        throw StaffTeleconsultRepositoryException(
          state.message ?? 'Teleconsultation is not joinable',
        );
      }
      final token = await widget.repository.requestJoinToken(
        teleconsultationId,
      );
      final session = await widget.roomClient.connect(
        token: token,
        publishVideo: true,
      );
      if (!mounted) {
        await session.disconnect();
        session.dispose();
        return;
      }
      session.addListener(_sessionChanged);
      setState(() {
        _state = state;
        _session = session;
        _joining = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _joining = false;
      });
    }
  }

  void _sessionChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _toggleMic() async {
    final session = _session;
    if (session == null) return;
    await session.setMicrophoneEnabled(!session.microphoneEnabled);
  }

  Future<void> _toggleCamera() async {
    final session = _session;
    if (session == null) return;
    await session.setCameraEnabled(!session.cameraEnabled);
  }

  Future<void> _toggleScreenShare() async {
    final session = _session;
    if (session == null) return;
    await session.setScreenShareEnabled(!session.screenShareEnabled);
  }

  Future<void> _endConsult() async {
    final session = _session;
    if (session == null || _ending) return;
    setState(() => _ending = true);
    await session.disconnect();
    if (!mounted) return;
    setState(() {
      _ending = false;
      _ended = true;
    });
  }

  void _openOpNote() {
    context.push(_appointment.opNoteRoute());
  }

  void _openPrescription() {
    context.push('/prescriptions', extra: _appointment.prescriptionContext());
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.lookup('staff_teleconsult.title'),
      body: ConstrainedContent(
        maxWidth: 1180,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: _joining
              ? _LoadingPanel(label: s.lookup('staff_teleconsult.connecting'))
              : _error != null
              ? _ErrorPanel(message: _error!, onRetry: _join)
              : _ConsultLayout(
                  appointment: _appointment,
                  state: _state,
                  session: _session,
                  ended: _ended,
                  ending: _ending,
                  onToggleMic: _toggleMic,
                  onToggleCamera: _toggleCamera,
                  onToggleScreenShare: _toggleScreenShare,
                  onEnd: _endConsult,
                  onOpenOpNote: _openOpNote,
                  onOpenPrescription: _openPrescription,
                ),
        ),
      ),
    );
  }
}

class _ConsultLayout extends StatelessWidget {
  const _ConsultLayout({
    required this.appointment,
    required this.state,
    required this.session,
    required this.ended,
    required this.ending,
    required this.onToggleMic,
    required this.onToggleCamera,
    required this.onToggleScreenShare,
    required this.onEnd,
    required this.onOpenOpNote,
    required this.onOpenPrescription,
  });

  final StaffTeleconsultAppointmentContext appointment;
  final StaffTeleconsultLobbyState? state;
  final StaffTeleconsultRoomSession? session;
  final bool ended;
  final bool ending;
  final VoidCallback onToggleMic;
  final VoidCallback onToggleCamera;
  final VoidCallback onToggleScreenShare;
  final VoidCallback onEnd;
  final VoidCallback onOpenOpNote;
  final VoidCallback onOpenPrescription;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final connected = session?.connected == true && !ended;
    final participantCount = session?.participantCount ?? 1;
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 900;
        final media = _MediaPane(
          session: session,
          connected: connected,
          ended: ended,
        );
        final actions = _ClinicalActionsPane(
          appointment: appointment,
          participantCount: participantCount,
          connected: connected,
          state: state,
          onOpenOpNote: onOpenOpNote,
          onOpenPrescription: onOpenPrescription,
        );
        return Column(
          children: [
            _Header(
              appointment: appointment,
              connected: connected,
              ended: ended,
              participantCount: participantCount,
            ),
            const SizedBox(height: 12),
            Expanded(
              child: wide
                  ? Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(flex: 3, child: media),
                        const SizedBox(width: 12),
                        SizedBox(width: 330, child: actions),
                      ],
                    )
                  : ListView(
                      children: [
                        SizedBox(height: 460, child: media),
                        const SizedBox(height: 12),
                        actions,
                      ],
                    ),
            ),
            const SizedBox(height: 12),
            _ControlBar(
              session: session,
              connected: connected,
              ending: ending,
              onToggleMic: onToggleMic,
              onToggleCamera: onToggleCamera,
              onToggleScreenShare: onToggleScreenShare,
              onEnd: onEnd,
            ),
            if (ended) ...[
              const SizedBox(height: 8),
              Text(
                s.lookup('staff_teleconsult.media_ended_appointment_open'),
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: AppTheme.textSecondary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.appointment,
    required this.connected,
    required this.ended,
    required this.participantCount,
  });

  final StaffTeleconsultAppointmentContext appointment;
  final bool connected;
  final bool ended;
  final int participantCount;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final status = ended
        ? s.lookup('staff_teleconsult.status.media_ended')
        : connected
        ? s.lookup('staff_teleconsult.status.connected')
        : s.lookup('staff_teleconsult.status.connecting');
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppTheme.surfaceWhite,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            const Icon(Icons.video_call_outlined, color: AppTheme.primaryBlue),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    appointment.patientName.isEmpty
                        ? s.lookup('queue.unknown_patient')
                        : appointment.patientName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  Text(
                    s.format('staff_teleconsult.participants', {
                      'count': participantCount,
                    }),
                    key: const Key('staff-teleconsult-participant-state'),
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
            _StatePill(label: status, connected: connected && !ended),
          ],
        ),
      ),
    );
  }
}

class _MediaPane extends StatelessWidget {
  const _MediaPane({
    required this.session,
    required this.connected,
    required this.ended,
  });

  final StaffTeleconsultRoomSession? session;
  final bool connected;
  final bool ended;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: ColoredBox(
        color: Colors.black,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (session == null || ended)
              _VideoFallback(
                icon: ended ? Icons.call_end_outlined : Icons.person_outline,
                label: ended
                    ? s.lookup('staff_teleconsult.call_ended')
                    : s.lookup('staff_teleconsult.remote_video'),
              )
            else
              session!.buildRemoteVideo(context),
            Positioned(
              right: 14,
              bottom: 14,
              child: SizedBox(
                width: 178,
                height: 112,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    border: Border.all(color: Colors.white70, width: 2),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: session == null || ended
                        ? _VideoFallback(
                            icon: Icons.videocam_off_outlined,
                            label: s.lookup('staff_teleconsult.local_video'),
                            compact: true,
                          )
                        : session!.buildLocalVideo(context),
                  ),
                ),
              ),
            ),
            Positioned(
              left: 14,
              top: 14,
              child: _StatePill(
                label: connected
                    ? s.lookup('staff_teleconsult.status.live')
                    : s.lookup('staff_teleconsult.status.media_closed'),
                connected: connected,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ClinicalActionsPane extends StatelessWidget {
  const _ClinicalActionsPane({
    required this.appointment,
    required this.participantCount,
    required this.connected,
    required this.state,
    required this.onOpenOpNote,
    required this.onOpenPrescription,
  });

  final StaffTeleconsultAppointmentContext appointment;
  final int participantCount;
  final bool connected;
  final StaffTeleconsultLobbyState? state;
  final VoidCallback onOpenOpNote;
  final VoidCallback onOpenPrescription;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppTheme.surfaceWhite,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              s.lookup('staff_teleconsult.clinical_actions'),
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 10),
            _InfoLine(
              icon: Icons.badge_outlined,
              text: s.format('staff_teleconsult.appointment_id', {
                'id': appointment.appointmentId,
              }),
            ),
            _InfoLine(
              icon: Icons.people_outline,
              text: s.format('staff_teleconsult.participants', {
                'count': participantCount,
              }),
            ),
            if (state?.joinState != null)
              _InfoLine(
                icon: Icons.info_outline,
                text: staffTeleconsultStateLabel(s, state!.joinState),
              ),
            const SizedBox(height: 14),
            FilledButton.icon(
              key: const Key('staff-teleconsult-op-note-action'),
              onPressed: appointment.patientUid.trim().isEmpty
                  ? null
                  : onOpenOpNote,
              icon: const Icon(Icons.note_alt_outlined),
              label: Text(s.lookup('staff_teleconsult.open_op_note')),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              key: const Key('staff-teleconsult-prescription-action'),
              onPressed: onOpenPrescription,
              icon: const Icon(Icons.medication_outlined),
              label: Text(s.lookup('staff_teleconsult.open_erx')),
            ),
          ],
        ),
      ),
    );
  }
}

class _ControlBar extends StatelessWidget {
  const _ControlBar({
    required this.session,
    required this.connected,
    required this.ending,
    required this.onToggleMic,
    required this.onToggleCamera,
    required this.onToggleScreenShare,
    required this.onEnd,
  });

  final StaffTeleconsultRoomSession? session;
  final bool connected;
  final bool ending;
  final VoidCallback onToggleMic;
  final VoidCallback onToggleCamera;
  final VoidCallback onToggleScreenShare;
  final VoidCallback onEnd;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final enabled = connected && session != null;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        border: Border.all(color: AppTheme.divider),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        child: Wrap(
          alignment: WrapAlignment.center,
          spacing: 10,
          runSpacing: 10,
          children: [
            _CircleControl(
              key: const Key('staff-teleconsult-mic-toggle'),
              tooltip: session?.microphoneEnabled == true
                  ? s.lookup('staff_teleconsult.mic_on')
                  : s.lookup('staff_teleconsult.mic_off'),
              icon: session?.microphoneEnabled == true
                  ? Icons.mic
                  : Icons.mic_off,
              onPressed: enabled ? onToggleMic : null,
            ),
            _CircleControl(
              key: const Key('staff-teleconsult-camera-toggle'),
              tooltip: session?.cameraEnabled == true
                  ? s.lookup('staff_teleconsult.camera_on')
                  : s.lookup('staff_teleconsult.camera_off'),
              icon: session?.cameraEnabled == true
                  ? Icons.videocam
                  : Icons.videocam_off,
              onPressed: enabled ? onToggleCamera : null,
            ),
            _CircleControl(
              key: const Key('staff-teleconsult-screen-share-toggle'),
              tooltip: session?.screenShareEnabled == true
                  ? s.lookup('staff_teleconsult.screen_share_on')
                  : s.lookup('staff_teleconsult.screen_share_off'),
              icon: Icons.screen_share_outlined,
              onPressed: enabled ? onToggleScreenShare : null,
            ),
            FilledButton.icon(
              key: const Key('staff-teleconsult-end-consult'),
              onPressed: enabled && !ending ? onEnd : null,
              icon: ending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.call_end_outlined),
              label: Text(s.lookup('staff_teleconsult.end_consult')),
              style: FilledButton.styleFrom(
                backgroundColor: AppTheme.errorRed,
                foregroundColor: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CircleControl extends StatelessWidget {
  const _CircleControl({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: IconButton.filledTonal(onPressed: onPressed, icon: Icon(icon)),
    );
  }
}

class _StatePill extends StatelessWidget {
  const _StatePill({required this.label, required this.connected});

  final String label;
  final bool connected;

  @override
  Widget build(BuildContext context) {
    final color = connected ? AppTheme.successGreen : AppTheme.textSecondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(99),
      ),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }
}

class _InfoLine extends StatelessWidget {
  const _InfoLine({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Icon(icon, size: 18, color: AppTheme.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                color: AppTheme.textSecondary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _VideoFallback extends StatelessWidget {
  const _VideoFallback({
    required this.icon,
    required this.label,
    this.compact = false,
  });

  final IconData icon;
  final String label;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: compact ? Colors.black54 : Colors.black87,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: Colors.white70, size: compact ? 24 : 42),
            if (!compact) ...[
              const SizedBox(height: 8),
              Text(
                label,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Colors.white70,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _LoadingPanel extends StatelessWidget {
  const _LoadingPanel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 12),
          Text(label, style: const TextStyle(fontWeight: FontWeight.w800)),
        ],
      ),
    );
  }
}

class _ErrorPanel extends StatelessWidget {
  const _ErrorPanel({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: AppTheme.surfaceWhite,
            border: Border.all(color: AppTheme.divider),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.video_call_outlined,
                  size: 42,
                  color: AppTheme.errorRed,
                ),
                const SizedBox(height: 10),
                Text(
                  message,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 14),
                OutlinedButton.icon(
                  onPressed: onRetry,
                  icon: const Icon(Icons.refresh),
                  label: Text(s.lookup('staff_teleconsult.retry')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
