import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class StaffPhoneMoreScreen extends StatelessWidget {
  const StaffPhoneMoreScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('More')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: const [
          _MoreTile(
            icon: Icons.schedule_outlined,
            title: 'My Roster',
            subtitle: 'Your shifts and duty plan',
            route: '/schedule',
          ),
          _MoreTile(
            icon: Icons.event_available_outlined,
            title: 'Leave',
            subtitle: 'Apply for leave and review status',
            route: '/leave',
          ),
          _MoreTile(
            icon: Icons.help_outline,
            title: 'Raise Query',
            subtitle: 'Ask HR/Admin or your incharge',
            route: '/phone/queries',
          ),
          _MoreTile(
            icon: Icons.report_gmailerrorred_outlined,
            title: 'Incident Report / Staff Grievance',
            subtitle: 'Confidential reporting and grievance submission',
            route: '/reports-grievances',
          ),
          _MoreTile(
            icon: Icons.folder_shared_outlined,
            title: 'Read-Only Patient Lookup',
            subtitle: 'Open authorized patient chart without write actions',
            route: '/phone/patient-lookup',
          ),
          _MoreTile(
            icon: Icons.person_outline,
            title: 'Profile',
            subtitle: 'Staff profile and device details',
            route: '/profile',
          ),
          _MoreTile(
            icon: Icons.settings_outlined,
            title: 'Settings',
            subtitle: 'Theme, language, and app settings',
            route: '/settings',
          ),
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
