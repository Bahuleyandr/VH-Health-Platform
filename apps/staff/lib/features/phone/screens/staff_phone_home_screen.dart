import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../../core/config/role_config.dart';
import '../../../core/providers/message_unread_provider.dart';
import '../../../core/providers/notification_provider.dart';
import '../../../core/theme/app_theme.dart';
import '../../phone/services/staff_phone_api_service.dart';

class StaffPhoneHomeScreen extends StatefulWidget {
  const StaffPhoneHomeScreen({super.key});

  @override
  State<StaffPhoneHomeScreen> createState() => _StaffPhoneHomeScreenState();
}

class _StaffPhoneHomeScreenState extends State<StaffPhoneHomeScreen> {
  late Future<Map<String, dynamic>> _future;

  @override
  void initState() {
    super.initState();
    _future = StaffPhoneApiService.getHome();
  }

  Future<void> _refresh() async {
    setState(() => _future = StaffPhoneApiService.getHome());
    await _future;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.surface,
      appBar: AppBar(title: const Text('Staff Phone')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: FutureBuilder<Map<String, dynamic>>(
          future: _future,
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snapshot.hasError) {
              return ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _PhoneBanner(
                    icon: Icons.error_outline,
                    title: 'Could not load staff phone home',
                    body: snapshot.error.toString().replaceFirst(
                      'Exception: ',
                      '',
                    ),
                    color: Theme.of(context).colorScheme.error,
                  ),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: _refresh,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Retry'),
                  ),
                ],
              );
            }

            final data = snapshot.data ?? const <String, dynamic>{};
            final counts = data['counts'] is Map
                ? Map<String, dynamic>.from(data['counts'] as Map)
                : const <String, dynamic>{};
            final attendance = data['attendance'] is Map
                ? Map<String, dynamic>.from(data['attendance'] as Map)
                : const <String, dynamic>{};
            final shift = data['shift'] is Map
                ? Map<String, dynamic>.from(data['shift'] as Map)
                : const <String, dynamic>{};
            final staff = data['staff'] is Map
                ? Map<String, dynamic>.from(data['staff'] as Map)
                : const <String, dynamic>{};
            final role = StaffRole.fromString(staff['role']?.toString() ?? '');
            final isHousekeeping =
                role == StaffRole.housekeeping ||
                role == StaffRole.housekeepingIncharge;
            final unreadMessages = context
                .watch<MessageUnreadProvider>()
                .unreadCount;
            final unreadAlerts = context
                .watch<NotificationProvider>()
                .unreadCount;

            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                const _PhoneBanner(
                  icon: Icons.phone_android,
                  title: 'Phone mode',
                  body:
                      'Non-clinical work only. Clinical entries must be completed on Staff Desktop.',
                  color: AppTheme.primaryBlue,
                ),
                const SizedBox(height: 16),
                GridView.count(
                  crossAxisCount: 2,
                  childAspectRatio: 1.55,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  mainAxisSpacing: 10,
                  crossAxisSpacing: 10,
                  children: [
                    _MetricCard(
                      icon: Icons.notifications_outlined,
                      label: 'Unread alerts',
                      value:
                          '${unreadAlerts > 0 ? unreadAlerts : _intOf(counts['unread_alerts'])}',
                      route: '/notifications',
                    ),
                    _MetricCard(
                      icon: Icons.chat_bubble_outline,
                      label: 'Unread messages',
                      value:
                          '${unreadMessages > 0 ? unreadMessages : _intOf(counts['unread_messages'])}',
                      route: '/messaging',
                    ),
                    _MetricCard(
                      icon: Icons.fingerprint_outlined,
                      label: 'Attendance',
                      value: attendance['is_checked_in'] == true
                          ? 'On duty'
                          : 'Not in',
                      route: '/attendance',
                    ),
                    _MetricCard(
                      icon: Icons.help_outline,
                      label: 'Pending queries',
                      value: '${_intOf(counts['pending_queries'])}',
                      route: '/phone/queries',
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                _SectionTitle(
                  title: 'Today',
                  trailing: Text(
                    (shift['label'] ?? 'Today shift').toString(),
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                ),
                const SizedBox(height: 8),
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.badge_outlined),
                    title: Text(
                      attendance['is_checked_in'] == true
                          ? 'Checked in'
                          : 'Not checked in',
                    ),
                    subtitle: Text(
                      attendance['check_in_time']?.toString() ??
                          'Use attendance for check-in, check-out, and breaks.',
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.push('/attendance'),
                  ),
                ),
                const SizedBox(height: 18),
                const _SectionTitle(title: 'Quick actions'),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    const _ActionChipButton(
                      icon: Icons.fingerprint,
                      label: 'Check in/out',
                      route: '/attendance',
                    ),
                    const _ActionChipButton(
                      icon: Icons.event_available,
                      label: 'Leave',
                      route: '/leave',
                    ),
                    const _ActionChipButton(
                      icon: Icons.chat,
                      label: 'Message',
                      route: '/messaging',
                    ),
                    const _ActionChipButton(
                      icon: Icons.report_gmailerrorred,
                      label: 'Incident',
                      route: '/reports-grievances',
                    ),
                    const _ActionChipButton(
                      icon: Icons.help,
                      label: 'Query',
                      route: '/phone/queries',
                    ),
                    if (isHousekeeping) ...[
                      const _ActionChipButton(
                        icon: Icons.checklist,
                        label: 'HK Tasks',
                        route: '/housekeeping-tasks',
                      ),
                      const _ActionChipButton(
                        icon: Icons.cleaning_services,
                        label: 'Housekeeping',
                        route: '/housekeeping',
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 18),
                Text(
                  'Policy ${data['policy_version'] ?? ''} ${_shortHash(data['policy_hash'])}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  static int _intOf(Object? value) =>
      value is int ? value : int.tryParse(value?.toString() ?? '') ?? 0;

  static String _shortHash(Object? value) {
    final text = value?.toString() ?? '';
    if (text.length <= 8) return text;
    return text.substring(0, 8);
  }
}

class _MetricCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final String route;

  const _MetricCard({
    required this.icon,
    required this.label,
    required this.value,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => context.push(route),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Icon(icon, color: AppTheme.primaryBlue),
              Text(value, style: Theme.of(context).textTheme.titleLarge),
              Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActionChipButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final String route;

  const _ActionChipButton({
    required this.icon,
    required this.label,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      avatar: Icon(icon, size: 18),
      label: Text(label),
      onPressed: () => context.push(route),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String title;
  final Widget? trailing;

  const _SectionTitle({required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.titleMedium),
        ),
        ?trailing,
      ],
    );
  }
}

class _PhoneBanner extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;
  final Color color;

  const _PhoneBanner({
    required this.icon,
    required this.title,
    required this.body,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 2),
                Text(
                  body,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
