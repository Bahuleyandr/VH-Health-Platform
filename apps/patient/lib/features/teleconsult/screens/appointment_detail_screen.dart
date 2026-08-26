import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/widgets/data_state_builder.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/features/appointments/models/appointment_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';
import 'package:vhhealth/features/teleconsult/models/teleconsult_route_args.dart';
import 'package:vhhealth/features/teleconsult/services/teleconsult_repository.dart';
import 'package:vhhealth/features/teleconsult/widgets/teleconsult_status_panel.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AppointmentDetailScreen extends StatefulWidget {
  const AppointmentDetailScreen({
    super.key,
    required this.appointment,
    this.initialTeleconsultState,
    this.repository = const TeleconsultRepository(),
    this.staleLabel,
    this.cachedAt,
  });

  final AppointmentInfo appointment;
  final TeleconsultLobbyState? initialTeleconsultState;
  final TeleconsultRepository repository;
  final String? staleLabel;
  final DateTime? cachedAt;

  @override
  State<AppointmentDetailScreen> createState() =>
      _AppointmentDetailScreenState();
}

class _AppointmentDetailScreenState extends State<AppointmentDetailScreen> {
  TeleconsultLobbyState? _teleconsultState;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _teleconsultState = widget.initialTeleconsultState;
    if (widget.appointment.isTeleconsult) {
      _loadTeleconsultState();
    }
  }

  Future<void> _loadTeleconsultState() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final state = await widget.repository.fetchLobbyState(
        widget.appointment.id,
      );
      if (!mounted) return;
      setState(() {
        _teleconsultState = state;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  void _openLobby() {
    final state = _teleconsultState;
    if (state == null || !state.joinable) return;
    context.push(
      '/teleconsult/appointments/${widget.appointment.id}/lobby',
      extra: TeleconsultRouteArgs(
        appointment: widget.appointment,
        initialState: state,
        repository: widget.repository,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final color = Theme.of(context).colorScheme.primary;
    return FeatureScreenScaffold(
      title: l.appointmentDetailTitle,
      icon: Icons.event_note_outlined,
      color: color,
      child: RefreshIndicator(
        onRefresh: widget.appointment.isTeleconsult
            ? _loadTeleconsultState
            : () async {},
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (widget.staleLabel != null || widget.cachedAt != null) ...[
              OfflineBanner(
                staleLabel: widget.staleLabel,
                cachedAt: widget.cachedAt,
              ),
              const SizedBox(height: 12),
            ],
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            widget.appointment.doctorName,
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                        if (widget.appointment.isTeleconsult)
                          _TeleBadge(label: l.teleconsultBadge),
                      ],
                    ),
                    const SizedBox(height: 8),
                    if (widget.appointment.department.isNotEmpty)
                      Text(widget.appointment.department),
                    const SizedBox(height: 12),
                    _DetailRow(
                      icon: Icons.calendar_today_outlined,
                      label: l.appointmentDetailDate,
                      value: widget.appointment.date,
                    ),
                    _DetailRow(
                      icon: Icons.schedule_outlined,
                      label: l.appointmentDetailTime,
                      value: widget.appointment.time,
                    ),
                    if (widget.appointment.reason?.isNotEmpty ?? false)
                      _DetailRow(
                        icon: Icons.notes_outlined,
                        label: l.appointmentDetailReason,
                        value: widget.appointment.reason!,
                      ),
                  ],
                ),
              ),
            ),
            if (widget.appointment.isTeleconsult) ...[
              const SizedBox(height: 12),
              if (_loading)
                const Center(child: CircularProgressIndicator())
              else if (_error != null)
                DataStateBuilder<TeleconsultLobbyState>(
                  isLoading: false,
                  error: _error,
                  data: const [],
                  onRetry: _loadTeleconsultState,
                  errorTitle: l.genericError,
                  errorActionLabel: l.commonRetry,
                  builder: (context, states) => const SizedBox.shrink(),
                )
              else
                TeleconsultStatusPanel(
                  state: _teleconsultState,
                  onJoin: _teleconsultState?.joinable == true
                      ? _openLobby
                      : null,
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Text(
            '$label: ',
            style: theme.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          Expanded(child: Text(value)),
        ],
      ),
    );
  }
}

class _TeleBadge extends StatelessWidget {
  const _TeleBadge({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      child: Chip(
        avatar: const Icon(Icons.videocam_outlined, size: 16),
        label: Text(label),
      ),
    );
  }
}
