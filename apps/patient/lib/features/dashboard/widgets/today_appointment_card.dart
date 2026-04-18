import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

/// Today's appointment card. Shows status and — when live queue data arrives
/// via the real-time fabric (`queue-position` event) — the patient's current
/// position and ETA. Falls back silently to the static status view if no
/// event has been received.
class TodayAppointmentCard extends StatefulWidget {
  final Map<String, dynamic> appointment;
  final String statusLabel;
  final Color statusColor;
  final IconData statusIcon;

  const TodayAppointmentCard({
    super.key,
    required this.appointment,
    required this.statusLabel,
    required this.statusColor,
    required this.statusIcon,
  });

  @override
  State<TodayAppointmentCard> createState() => _TodayAppointmentCardState();
}

class _TodayAppointmentCardState extends State<TodayAppointmentCard> {
  StreamSubscription<RealtimeEvent>? _sub;
  int? _position;
  int? _etaMinutes;

  @override
  void initState() {
    super.initState();
    _attachRealtime();
  }

  @override
  void didUpdateWidget(covariant TodayAppointmentCard old) {
    super.didUpdateWidget(old);
    if (old.appointment['id']?.toString() != widget.appointment['id']?.toString()) {
      _position = null;
      _etaMinutes = null;
      _attachRealtime();
    }
  }

  Future<void> _attachRealtime() async {
    await _sub?.cancel();
    // queue-position is per-user (sendToUser) — no broadcast subscribe needed.
    final rt = RealtimeClient.instance;
    await rt.connect();
    final myAppointmentId = widget.appointment['id']?.toString();
    if (myAppointmentId == null) return;
    _sub = rt.events('queue-position', broadcastChannel: false).listen((evt) {
      if (evt.data['appointmentId']?.toString() != myAppointmentId) return;
      if (!mounted) return;
      setState(() {
        _position = (evt.data['position'] as num?)?.toInt();
        _etaMinutes = (evt.data['etaMinutes'] as num?)?.toInt();
      });
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  String? _liveLine() {
    if (_position == null) return null;
    if (_position == 0) return 'You\'re next';
    final base = _position == 1
        ? 'Dr. is 1 patient away'
        : 'Dr. is $_position patients away';
    if (_etaMinutes != null && _etaMinutes! > 0) {
      return '$base — est. $_etaMinutes min';
    }
    return base;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final doctorName = widget.appointment['doctor_name']?.toString() ?? 'Doctor';
    final time = widget.appointment['appointment_time']?.toString() ?? '';
    final live = _liveLine();

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: widget.statusColor.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: widget.statusColor.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Icon(widget.statusIcon, color: widget.statusColor, size: 28),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: widget.statusColor,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        'TODAY',
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 10,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      widget.statusLabel,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: widget.statusColor,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  'Dr. $doctorName${time.isNotEmpty ? ' • $time' : ''}',
                  style: theme.textTheme.bodySmall,
                ),
                if (live != null) ...[
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Icon(Icons.sensors, size: 14, color: widget.statusColor),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          live,
                          style: theme.textTheme.bodySmall?.copyWith(
                            fontWeight: FontWeight.w600,
                            color: widget.statusColor,
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
