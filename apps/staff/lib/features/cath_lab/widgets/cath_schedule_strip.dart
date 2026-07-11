import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../l10n/app_strings.dart';
import '../services/cath_lab_api_service.dart';

/// NL13-P1f — read-only room-schedule strip for the cath workbench.
///
/// Shows the day's booked slots straight from the Scheduling 2.0 rails plus
/// any active emergency cases. An emergency only FLAGS overlapped bookings
/// (soft conflict); it never cancels or blocks them, so the strip renders the
/// booking untouched with a warning chip.
class CathScheduleStripSection extends StatefulWidget {
  const CathScheduleStripSection({
    super.key,
    required this.date,
    this.loadStrip,
  });

  final DateTime date;
  final Future<CathScheduleStrip> Function(DateTime date)? loadStrip;

  @override
  State<CathScheduleStripSection> createState() =>
      _CathScheduleStripSectionState();
}

class _CathScheduleStripSectionState extends State<CathScheduleStripSection> {
  CathScheduleStrip? _strip;
  bool _loading = true;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(CathScheduleStripSection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.date != widget.date) _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final loader = widget.loadStrip ?? CathLabApiService.fetchScheduleStrip;
      final strip = await loader(widget.date);
      if (!mounted) return;
      setState(() {
        _strip = strip;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _failed = true;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.meeting_room_outlined,
                  size: 20,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    s.lookup('s4.lib.cath_lab.strip.title'),
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                if (_strip?.hasSoftConflict ?? false)
                  Tooltip(
                    message: s.lookup('s4.lib.cath_lab.strip.soft_conflict'),
                    child: Icon(
                      Icons.warning_amber_rounded,
                      size: 20,
                      color: Colors.amber.shade800,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Center(
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            else if (_failed)
              Row(
                children: [
                  Expanded(
                    child: Text(
                      s.lookup('s4.lib.cath_lab.strip.load_failed'),
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                  TextButton(onPressed: _load, child: Text(s.actionRefresh)),
                ],
              )
            else ...[
              if ((_strip?.emergencies ?? []).isNotEmpty)
                _EmergencyBanner(emergencies: _strip!.emergencies),
              if ((_strip?.bookings ?? []).isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    s.lookup('s4.lib.cath_lab.strip.no_bookings'),
                    style: theme.textTheme.bodySmall,
                  ),
                )
              else
                for (final booking in _strip!.bookings)
                  _BookingRow(booking: booking),
            ],
          ],
        ),
      ),
    );
  }
}

class _EmergencyBanner extends StatelessWidget {
  const _EmergencyBanner({required this.emergencies});

  final List<CathScheduleEmergency> emergencies;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.amber.shade50,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.amber.shade300),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.emergency_outlined,
                size: 16,
                color: Colors.amber.shade900,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  s.lookup('s4.lib.cath_lab.strip.emergency_banner'),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: Colors.amber.shade900,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          for (final emergency in emergencies)
            Padding(
              padding: const EdgeInsets.only(top: 4, left: 22),
              child: Text(
                [
                  if (emergency.startedAt != null)
                    DateFormat('HH:mm').format(emergency.startedAt!.toLocal()),
                  emergency.requestedProcedure,
                  emergency.patientName,
                ].where((part) => part.isNotEmpty).join(' · '),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: Colors.amber.shade900,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _BookingRow extends StatelessWidget {
  const _BookingRow({required this.booking});

  final CathScheduleBooking booking;

  String _window() {
    final format = DateFormat('HH:mm');
    final start = booking.startsAt != null
        ? format.format(booking.startsAt!.toLocal())
        : '--:--';
    final end = booking.endsAt != null
        ? format.format(booking.endsAt!.toLocal())
        : '--:--';
    return '$start–$end';
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 88,
            child: Text(
              _window(),
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  booking.resourceName,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  [booking.patientName, booking.requestedProcedure]
                      .where((part) => part.isNotEmpty)
                      .join(' · '),
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          if (booking.softConflict)
            Tooltip(
              message: s.lookup('s4.lib.cath_lab.strip.soft_conflict'),
              child: Padding(
                padding: const EdgeInsets.only(left: 6),
                child: Icon(
                  Icons.warning_amber_rounded,
                  size: 18,
                  color: Colors.amber.shade800,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
