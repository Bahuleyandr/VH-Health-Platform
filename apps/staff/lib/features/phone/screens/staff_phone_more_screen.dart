import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/role_config.dart';
import '../../../core/services/auth_service.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

class StaffPhoneMoreScreen extends StatefulWidget {
  const StaffPhoneMoreScreen({super.key});

  @override
  State<StaffPhoneMoreScreen> createState() => _StaffPhoneMoreScreenState();
}

class _StaffPhoneMoreScreenState extends State<StaffPhoneMoreScreen> {
  StaffRole _role = StaffRole.general;
  bool _loadingRole = true;

  @override
  void initState() {
    super.initState();
    _loadRole();
  }

  Future<void> _loadRole() async {
    try {
      final role = StaffRole.fromString(await AuthService.getRole());
      if (mounted) {
        setState(() {
          _role = role;
          _loadingRole = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loadingRole = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tiles = <Widget>[
      const _MoreTile(
        icon: Icons.schedule_outlined,
        titleKey: 's4.lib.staff_phone_more.my_roster',
        subtitleKey: 's4.lib.staff_phone_more.my_roster_subtitle',
        route: '/schedule',
      ),
      const _MoreTile(
        icon: Icons.event_available_outlined,
        titleKey: 'leave.title',
        subtitleKey: 's4.lib.staff_phone_more.leave_subtitle',
        route: '/leave',
      ),
      const _MoreTile(
        icon: Icons.help_outline,
        titleKey: 's4.lib.staff_query.raise_query',
        subtitleKey: 's4.lib.staff_phone_more.raise_query_subtitle',
        route: '/phone/queries',
      ),
      const _MoreTile(
        icon: Icons.report_gmailerrorred_outlined,
        titleKey: 's4.lib.staff_phone_more.incident_grievance',
        subtitleKey: 's4.lib.staff_phone_more.incident_grievance_subtitle',
        route: '/reports-grievances',
      ),
      if (RoleFeatures.hasPhoneReadOnlyPatientLookup(_role))
        const _MoreTile(
          icon: Icons.folder_shared_outlined,
          titleKey: 's4.lib.staff_phone_more.read_only_patient_lookup',
          subtitleKey:
              's4.lib.staff_phone_more.read_only_patient_lookup_subtitle',
          route: '/phone/patient-lookup',
        ),
      const _MoreTile(
        icon: Icons.person_outline,
        titleKey: 'profile.title',
        subtitleKey: 's4.lib.staff_phone_more.profile_subtitle',
        route: '/profile',
      ),
      const _MoreTile(
        icon: Icons.settings_outlined,
        titleKey: 'settings.title',
        subtitleKey: 's4.lib.staff_phone_more.settings_subtitle',
        route: '/settings',
      ),
    ];

    return Scaffold(
      appBar: AppBar(title: const AppText('s4.lib.staff_phone_more.more')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (_loadingRole) const LinearProgressIndicator(minHeight: 2),
          ...tiles,
        ],
      ),
    );
  }
}

class _MoreTile extends StatelessWidget {
  final IconData icon;
  final String titleKey;
  final String subtitleKey;
  final String route;

  const _MoreTile({
    required this.icon,
    required this.titleKey,
    required this.subtitleKey,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: Icon(icon),
        title: AppText(titleKey),
        subtitle: AppText(subtitleKey),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => context.push(route),
      ),
    );
  }
}
