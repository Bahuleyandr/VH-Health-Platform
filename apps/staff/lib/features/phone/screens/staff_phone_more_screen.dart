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
        title: 'My Roster',
        subtitle: 'Your shifts and duty plan',
        route: '/schedule',
      ),
      const _MoreTile(
        icon: Icons.event_available_outlined,
        title: 'Leave',
        subtitle: 'Apply for leave and review status',
        route: '/leave',
      ),
      const _MoreTile(
        icon: Icons.help_outline,
        title: 'Raise Query',
        subtitle: 'Ask HR/Admin or your incharge',
        route: '/phone/queries',
      ),
      const _MoreTile(
        icon: Icons.report_gmailerrorred_outlined,
        title: 'Incident Report / Staff Grievance',
        subtitle: 'Confidential reporting and grievance submission',
        route: '/reports-grievances',
      ),
      if (RoleFeatures.hasPhoneReadOnlyPatientLookup(_role))
        const _MoreTile(
          icon: Icons.folder_shared_outlined,
          title: 'Read-Only Patient Lookup',
          subtitle: 'Open authorized patient chart without write actions',
          route: '/phone/patient-lookup',
        ),
      const _MoreTile(
        icon: Icons.person_outline,
        title: 'Profile',
        subtitle: 'Staff profile and device details',
        route: '/profile',
      ),
      const _MoreTile(
        icon: Icons.settings_outlined,
        title: 'Settings',
        subtitle: 'Theme, language, and app settings',
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
  final String title;
  final String subtitle;
  final String route;

  const _MoreTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: Icon(icon),
        title: Text(title),
        subtitle: Text(subtitle),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => context.push(route),
      ),
    );
  }
}
