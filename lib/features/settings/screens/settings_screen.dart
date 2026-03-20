import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../main.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  Future<void> _logout(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Logout'),
        content: const Text('Are you sure you want to logout?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppTheme.errorRed),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Logout'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      await AuthService.logout();
      if (context.mounted) context.go('/login');
    }
  }

  @override
  Widget build(BuildContext context) {
    final themeNotifier = context.watch<ThemeNotifier>();
    final isDark = themeNotifier.mode == ThemeMode.dark;

    return StaffScaffold(
      title: 'Settings',
      currentIndex: 4,
      showBottomNav: true,
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // App section
          _SectionHeader(title: 'Appearance'),
          _SettingsCard(
            children: [
              SwitchListTile(
                title: const Text('Dark Mode'),
                subtitle: const Text('Toggle dark/light theme'),
                secondary: Icon(
                  isDark ? Icons.dark_mode : Icons.light_mode,
                  color: AppTheme.primaryBlue,
                ),
                value: isDark,
                activeColor: AppTheme.primaryBlue,
                onChanged: (_) => themeNotifier.toggleTheme(),
              ),
            ],
          ),
          const SizedBox(height: 16),

          _SectionHeader(title: 'Notifications'),
          _SettingsCard(
            children: [
              _SettingsTile(
                icon: Icons.notifications_outlined,
                title: 'Push Notifications',
                subtitle: 'Attendance reminders, appointment alerts',
                trailing: Switch(
                  value: true,
                  activeColor: AppTheme.primaryBlue,
                  onChanged: (_) {},
                ),
              ),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.schedule,
                title: 'Shift Reminders',
                subtitle: 'Get notified before shift starts',
                trailing: Switch(
                  value: true,
                  activeColor: AppTheme.primaryBlue,
                  onChanged: (_) {},
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),

          _SectionHeader(title: 'Security'),
          _SettingsCard(
            children: [
              _SettingsTile(
                icon: Icons.fingerprint,
                title: 'Biometric Login',
                subtitle: 'Use fingerprint to sign in',
                trailing: const Icon(Icons.chevron_right,
                    color: AppTheme.textSecondary),
                onTap: () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                        content:
                            Text('Biometric setup requires device enrollment')),
                  );
                },
              ),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.pin_outlined,
                title: 'Change PIN',
                subtitle: 'Update your 4–6 digit quick-access PIN',
                trailing: const Icon(Icons.chevron_right,
                    color: AppTheme.textSecondary),
                onTap: () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                        content: Text('PIN change coming soon')),
                  );
                },
              ),
            ],
          ),
          const SizedBox(height: 16),

          _SectionHeader(title: 'Quick Links'),
          _SettingsCard(
            children: [
              _SettingsTile(
                icon: Icons.person_outlined,
                title: 'Profile',
                subtitle: 'View and edit your staff profile',
                trailing: const Icon(Icons.chevron_right,
                    color: AppTheme.textSecondary),
                onTap: () => context.go('/profile'),
              ),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.fingerprint,
                title: 'Attendance',
                subtitle: 'Check in/out and view history',
                trailing: const Icon(Icons.chevron_right,
                    color: AppTheme.textSecondary),
                onTap: () => context.go('/attendance'),
              ),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.event_available,
                title: 'Leave',
                subtitle: 'Apply for leave and check balance',
                trailing: const Icon(Icons.chevron_right,
                    color: AppTheme.textSecondary),
                onTap: () => context.go('/leave'),
              ),
            ],
          ),
          const SizedBox(height: 16),

          _SectionHeader(title: 'About'),
          _SettingsCard(
            children: [
              _SettingsTile(
                icon: Icons.info_outlined,
                title: 'App Version',
                subtitle: '1.0.0+1',
              ),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.local_hospital_outlined,
                title: 'VHHealth Staff Portal',
                subtitle: 'Hospital staff management system',
              ),
            ],
          ),
          const SizedBox(height: 24),

          // Logout
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: () => _logout(context),
              icon: const Icon(Icons.logout, color: Colors.white),
              label: const Text('Logout'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.errorRed,
                minimumSize: const Size(double.infinity, 52),
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String title;
  const _SectionHeader({required this.title});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, left: 4),
      child: Text(
        title.toUpperCase(),
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.bold,
          color: AppTheme.textSecondary,
          letterSpacing: 1.2,
        ),
      ),
    );
  }
}

class _SettingsCard extends StatelessWidget {
  final List<Widget> children;
  const _SettingsCard({required this.children});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Column(children: children),
    );
  }
}

class _SettingsTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  const _SettingsTile({
    required this.icon,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon, color: AppTheme.primaryBlue),
      title: Text(title,
          style: const TextStyle(
              fontWeight: FontWeight.w500, color: AppTheme.textPrimary)),
      subtitle: subtitle != null
          ? Text(subtitle!,
              style:
                  const TextStyle(color: AppTheme.textSecondary, fontSize: 12))
          : null,
      trailing: trailing,
      onTap: onTap,
    );
  }
}
