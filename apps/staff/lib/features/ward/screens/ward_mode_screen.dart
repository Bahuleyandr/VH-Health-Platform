import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class WardModeScreen extends StatefulWidget {
  const WardModeScreen({super.key});

  @override
  State<WardModeScreen> createState() => _WardModeScreenState();
}

class _WardModeScreenState extends State<WardModeScreen> {
  StaffRole _role = StaffRole.general;

  @override
  void initState() {
    super.initState();
    _loadRole();
  }

  Future<void> _loadRole() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    if (mounted) setState(() => _role = role);
  }

  @override
  Widget build(BuildContext context) {
    final actions = _actionsForRole(_role);
    return StaffScaffold(
      title: 'Ward Mode',
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
        children: [
          _buildHeader(),
          const SizedBox(height: 14),
          LayoutBuilder(
            builder: (context, constraints) {
              final width = constraints.maxWidth;
              final crossAxisCount = width >= 980
                  ? 4
                  : width >= 680
                  ? 3
                  : 2;
              return GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: actions.length,
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: crossAxisCount,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                  childAspectRatio: width < 520 ? 1.15 : 1.45,
                ),
                itemBuilder: (context, index) =>
                    _WardActionTile(action: actions[index]),
              );
            },
          ),
          const SizedBox(height: 14),
          _buildNextPhasePanel(),
        ],
      ),
    );
  }

  Widget _buildHeader() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: AppTheme.primaryTeal.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Icon(
              Icons.local_hospital_outlined,
              color: AppTheme.primaryTeal,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppText(
                  's4.lib.ward_mode.ward_workbench',
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
                ),
                Text(
                  _role == StaffRole.nurse ||
                          _role == StaffRole.nursingIncharge ||
                          _role == StaffRole.nursingSuperintendent
                      ? 'Vitals, nursing notes, medication rounds, and handover.'
                      : 'Notes, investigations, orders, admissions, and discharge work.',
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildNextPhasePanel() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.primaryBlue.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.primaryBlue.withValues(alpha: 0.24)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.schema_outlined, color: AppTheme.primaryBlue),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppText(
                  's4.lib.ward_mode.built_for_ward_specific_flows',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: AppTheme.primaryBlue,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 4),
                AppText(
                  's4.lib.ward_mode.this_uses_the_same_workbench_pattern_as_receptio',
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<_WardAction> _actionsForRole(StaffRole role) {
    final isNursing =
        role == StaffRole.nurse ||
        role == StaffRole.nursingIncharge ||
        role == StaffRole.nursingSuperintendent;
    if (isNursing) {
      return const [
        _WardAction(
          title: 'Command Board',
          subtitle: 'Patients, alerts, tasks',
          icon: Icons.view_timeline_outlined,
          color: AppTheme.primaryBlue,
          route: '/patient-command-board',
        ),
        _WardAction(
          title: 'Bed Board',
          subtitle: 'Ward and ICU census',
          icon: Icons.local_hotel,
          color: AppTheme.primaryBlue,
          route: '/beds',
        ),
        _WardAction(
          title: 'Nursing Notes',
          subtitle: 'IP notes',
          icon: Icons.edit_note,
          color: AppTheme.primaryTeal,
          route: '/nursing-notes',
        ),
        _WardAction(
          title: 'Due Medications',
          subtitle: 'Medication rounds',
          icon: Icons.medication,
          color: AppTheme.warningAmber,
          route: '/mar/due',
        ),
        _WardAction(
          title: 'Shift Handover',
          subtitle: 'General shift notes',
          icon: Icons.swap_horiz,
          color: AppTheme.primaryTeal,
          route: '/handover',
        ),
        _WardAction(
          title: 'IP Records',
          subtitle: 'Current admission files',
          icon: Icons.folder_shared,
          color: AppTheme.primaryBlue,
          route: '/patient-records?context=ip',
        ),
      ];
    }

    return const [
      _WardAction(
        title: 'Command Board',
        subtitle: 'Priority, diagnosis, tasks',
        icon: Icons.view_timeline_outlined,
        color: AppTheme.primaryBlue,
        route: '/patient-command-board',
      ),
      _WardAction(
        title: 'Bed Board',
        subtitle: 'Select admitted patient',
        icon: Icons.local_hotel,
        color: AppTheme.primaryBlue,
        route: '/beds',
      ),
      _WardAction(
        title: 'IP Records',
        subtitle: 'Current admission files',
        icon: Icons.folder_shared,
        color: AppTheme.primaryBlue,
        route: '/patient-records?context=ip',
      ),
      _WardAction(
        title: 'Investigations',
        subtitle: 'Orders and results',
        icon: Icons.biotech,
        color: AppTheme.accentCyan,
        route: '/investigations',
      ),
      _WardAction(
        title: 'Prescriptions',
        subtitle: 'OP and IP medicines',
        icon: Icons.medication_liquid,
        color: AppTheme.primaryTeal,
        route: '/prescriptions',
      ),
      _WardAction(
        title: 'Discharge Hub',
        subtitle: 'Pending discharge work',
        icon: Icons.rule_folder,
        color: AppTheme.warningAmber,
        route: '/emr/discharge-hub',
      ),
      _WardAction(
        title: 'Clinical AI',
        subtitle: 'Review queued drafts',
        icon: Icons.fact_check_outlined,
        color: AppTheme.accentCyan,
        route: '/clinical-ai/queue',
      ),
    ];
  }
}

class _WardAction {
  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  final String route;

  const _WardAction({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
    required this.route,
  });
}

class _WardActionTile extends StatelessWidget {
  final _WardAction action;

  const _WardActionTile({required this.action});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => context.push(action.route),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppTheme.divider),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: action.color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(action.icon, color: action.color),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  action.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  action.subtitle,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
