import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class StaffRosterHubScreen extends StatefulWidget {
  const StaffRosterHubScreen({super.key});

  @override
  State<StaffRosterHubScreen> createState() => _StaffRosterHubScreenState();
}

class _StaffRosterHubScreenState extends State<StaffRosterHubScreen> {
  StaffRole _role = StaffRole.general;

  static const _rosters = [
    _RosterHubItem(
      title: 'Doctor roster',
      subtitle: 'Duty doctors and medical cover',
      department: 'medical',
      icon: Icons.medical_services_outlined,
      color: Color(0xFF0D47A1),
    ),
    _RosterHubItem(
      title: 'Nursing roster',
      subtitle: 'Ward, ICU, ER, and floor nursing teams',
      department: 'nursing',
      icon: Icons.assignment_ind_outlined,
      color: Color(0xFF00695C),
    ),
    _RosterHubItem(
      title: 'OP nursing roster',
      subtitle: 'OP counters, procedure rooms, and clinic support',
      department: 'op_nursing',
      icon: Icons.event_note_outlined,
      color: Color(0xFF00838F),
    ),
    _RosterHubItem(
      title: 'Reception roster',
      subtitle: 'Front desk, OPD, admission, and billing counters',
      department: 'reception',
      icon: Icons.support_agent_outlined,
      color: Color(0xFF455A64),
    ),
    _RosterHubItem(
      title: 'Housekeeping roster',
      subtitle: 'Floor and zone cleaning deployment',
      department: 'housekeeping',
      icon: Icons.cleaning_services_outlined,
      color: Color(0xFF007A64),
    ),
    _RosterHubItem(
      title: 'Maintenance roster',
      subtitle: 'Electrical, biomedical, and facility cover',
      department: 'maintenance',
      icon: Icons.engineering_outlined,
      color: Color(0xFFF9A825),
    ),
    _RosterHubItem(
      title: 'Pharmacy roster',
      subtitle: 'Dispensing, IP pharmacy, and handover cover',
      department: 'pharmacy',
      icon: Icons.local_pharmacy_outlined,
      color: Color(0xFFE65100),
    ),
    _RosterHubItem(
      title: 'Driver roster',
      subtitle: 'Ambulance and transport duty deployment',
      department: 'ambulance',
      icon: Icons.local_shipping_outlined,
      color: Color(0xFF5D4037),
    ),
  ];

  @override
  void initState() {
    super.initState();
    _loadRole();
  }

  Future<void> _loadRole() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (mounted) setState(() => _role = role);
  }

  List<_StaffHubAction> get _staffRecordActions {
    final actions = <_StaffHubAction>[];
    if (RoleFeatures.hasStaffOnboarding(_role)) {
      actions.add(
        const _StaffHubAction(
          title: 'Staff onboarding',
          subtitle: 'Create staff accounts, assign roles, and set departments',
          route: '/staff-management',
          icon: Icons.manage_accounts_outlined,
          color: Color(0xFF4527A0),
        ),
      );
    }
    if (RoleFeatures.hasStaffOnboarding(_role) ||
        _role == StaffRole.medicalSuperintendent) {
      actions.add(
        const _StaffHubAction(
          title: 'Staff directory',
          subtitle: 'Search staff by name, role, department, or employee ID',
          route: '/staff-directory',
          icon: Icons.people_outline,
          color: Color(0xFF455A64),
        ),
      );
    }
    return actions;
  }

  List<_RosterHubItem> get _visibleRosters {
    if (RoleFeatures.hasStaffRosterHub(_role)) return _rosters;
    final department = _role.rosterDepartment;
    if (department == null) return const [];
    return _rosters
        .where((roster) => roster.department == department)
        .toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    final staffRecordActions = _staffRecordActions;
    final visibleRosters = _visibleRosters;
    return StaffScaffold(
      title: 'Staff Roster',
      body: LayoutBuilder(
        builder: (context, constraints) {
          final isWide = constraints.maxWidth >= 760;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (staffRecordActions.isNotEmpty) ...[
                const _SectionLabel(text: 'Staff records'),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    for (final action in staffRecordActions)
                      SizedBox(
                        width: isWide
                            ? ((constraints.maxWidth - 44) / 2)
                                  .clamp(300, 560)
                                  .toDouble()
                            : double.infinity,
                        child: _StaffActionTile(action: action),
                      ),
                  ],
                ),
                const SizedBox(height: 18),
              ],
              const _SectionLabel(text: 'Department rosters'),
              const SizedBox(height: 10),
              _HeaderCard(isWide: isWide),
              const SizedBox(height: 14),
              if (visibleRosters.isEmpty)
                const _EmptyRosterState()
              else
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    for (final item in visibleRosters)
                      SizedBox(
                        width: isWide
                            ? ((constraints.maxWidth - 44) / 2)
                                  .clamp(300, 560)
                                  .toDouble()
                            : double.infinity,
                        child: _RosterTile(item: item),
                      ),
                  ],
                ),
            ],
          );
        },
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel({required this.text});

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(
        color: AppTheme.textSecondary,
        fontSize: 13,
        fontWeight: FontWeight.w800,
      ),
    );
  }
}

class _EmptyRosterState extends StatelessWidget {
  const _EmptyRosterState();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        children: [
          Icon(Icons.lock_outline, color: AppTheme.textSecondary),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'No department roster board is assigned to this role.',
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}

class _HeaderCard extends StatelessWidget {
  final bool isWide;
  const _HeaderCard({required this.isWide});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: AppTheme.primaryBlue.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(
              Icons.calendar_month_outlined,
              color: AppTheme.primaryBlue,
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Department roster boards',
                  style: TextStyle(
                    color: AppTheme.textPrimary,
                    fontSize: isWide ? 20 : 18,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Choose a department to manage weekly duties, leave blocks, requests, and roster forecast overlays.',
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StaffActionTile extends StatelessWidget {
  final _StaffHubAction action;
  const _StaffActionTile({required this.action});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => context.push(action.route),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: action.color.withValues(alpha: 0.16),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(action.icon, color: action.color),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    action.title,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w800,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    action.subtitle,
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: AppTheme.textSecondary),
          ],
        ),
      ),
    );
  }
}

class _RosterTile extends StatelessWidget {
  final _RosterHubItem item;
  const _RosterTile({required this.item});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: () => context.push('/staff-roster/${item.department}'),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: item.color.withValues(alpha: 0.16),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(item.icon, color: item.color),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.title,
                    style: TextStyle(
                      color: AppTheme.textPrimary,
                      fontWeight: FontWeight.w800,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    item.subtitle,
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: AppTheme.textSecondary),
          ],
        ),
      ),
    );
  }
}

class _StaffHubAction {
  final String title;
  final String subtitle;
  final String route;
  final IconData icon;
  final Color color;

  const _StaffHubAction({
    required this.title,
    required this.subtitle,
    required this.route,
    required this.icon,
    required this.color,
  });
}

class _RosterHubItem {
  final String title;
  final String subtitle;
  final String department;
  final IconData icon;
  final Color color;

  const _RosterHubItem({
    required this.title,
    required this.subtitle,
    required this.department,
    required this.icon,
    required this.color,
  });
}
