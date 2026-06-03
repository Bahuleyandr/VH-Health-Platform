import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../theme/app_theme.dart';

/// A pinned banner shown at the top of forms (Vitals, Nursing Notes,
/// Handover) when the screen was opened from the bed-board with a patient
/// already in context. Tells the nurse who the form is "For", and offers
/// a one-tap exit if they actually meant to log a different patient.
///
/// All fields optional — only renders the rows that have a value.
///
/// Visual: a coloured strip of [accent.alpha=0.06], a person icon, the
/// patient name in bold, optional phone underneath, and an "X" button
/// on the right that clears the prefill by re-routing to the bare
/// screen path. The bare path is whatever pushed this screen minus
/// query params, so we use [GoRouter.of(context).uri] and rebuild it.
class PatientContextChip extends StatelessWidget {
  final String? name;
  final String? phone;
  final Color accent;
  final String? subtitle;
  const PatientContextChip({
    super.key,
    this.name,
    this.phone,
    this.accent = AppTheme.primaryBlue,
    this.subtitle,
  });

  void _clear(BuildContext context) {
    final uri = GoRouter.of(context).state.uri;
    // Drop all query params; keep the path so the form resets to its
    // empty state (the screen's State.didUpdateWidget kicks back in).
    context.replace(uri.path);
  }

  @override
  Widget build(BuildContext context) {
    final showName = (name ?? '').trim().isNotEmpty;
    if (!showName) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      color: accent.withValues(alpha: 0.08),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Icon(Icons.person_pin_circle_outlined, color: accent, size: 22),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'For: $name',
                  style: TextStyle(
                    color: accent,
                    fontWeight: FontWeight.w600,
                    fontSize: 14,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
                if ((phone ?? '').trim().isNotEmpty)
                  Text(
                    phone!,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
                if ((subtitle ?? '').trim().isNotEmpty)
                  Text(
                    subtitle!,
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 12,
                    ),
                  ),
              ],
            ),
          ),
          // Close button — bumped from the default 18pt icon / 8pt
          // padding combo (≈34pt hit target) to a Material-recommended
          // 24pt icon + 12pt padding (= 48pt minimum). Helps users with
          // motor impairments and matches WCAG 2.5.5.
          IconButton(
            icon: Icon(Icons.close, color: accent, size: 24),
            iconSize: 24,
            padding: const EdgeInsets.all(12),
            constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
            tooltip: 'Clear patient context',
            onPressed: () => _clear(context),
          ),
        ],
      ),
    );
  }
}
