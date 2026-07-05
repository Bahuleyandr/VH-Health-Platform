import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

/// Legacy compatibility screen.
///
/// Appointment queue operations now live inside the Front Office Workbench so
/// patient search, OP booking, queue status, billing, and admission handoff
/// stay in one workstation surface.
class AppointmentQueueScreen extends StatefulWidget {
  const AppointmentQueueScreen({super.key});

  @override
  State<AppointmentQueueScreen> createState() => _AppointmentQueueScreenState();
}

class _AppointmentQueueScreenState extends State<AppointmentQueueScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.go('/front-office');
    });
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: AppStrings.of(
        context,
      ).lookup('role.feature.front_office_workbench'),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.space_dashboard_outlined,
                  color: AppTheme.primaryBlue,
                  size: 42,
                ),
                const SizedBox(height: 14),
                AppText(
                  's4.lib.appointment_queue.opening_front_office_workbench',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                AppText(
                  's4.lib.appointment_queue.appointment_queue_workflows_now_run_from_the_con',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () => context.go('/front-office'),
                  icon: const Icon(Icons.open_in_new),
                  label: const AppText(
                    's4.lib.appointment_queue.open_front_office',
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
