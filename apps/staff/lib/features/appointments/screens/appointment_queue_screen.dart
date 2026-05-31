import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

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
      title: 'Front Office',
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
                Text(
                  'Opening Front Office Workbench',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Appointment queue workflows now run from the consolidated workbench.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () => context.go('/front-office'),
                  icon: const Icon(Icons.open_in_new),
                  label: const Text('Open Front Office'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
