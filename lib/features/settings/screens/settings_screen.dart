import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../../core/config/api_config.dart';
import '../../../core/providers/theme_provider.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  Future<void> _showSetupPinDialog(BuildContext context) async {
    final pinCtrl = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Set Up PIN'),
        content: Form(
          key: formKey,
          child: TextFormField(
            controller: pinCtrl,
            obscureText: true,
            keyboardType: TextInputType.number,
            maxLength: 6,
            decoration: const InputDecoration(
              labelText: 'Enter 4–6 digit PIN',
              prefixIcon: Icon(Icons.pin_outlined),
            ),
            validator: (v) {
              if (v == null || v.isEmpty) return 'PIN is required';
              if (v.length < 4) return 'Minimum 4 digits';
              return null;
            },
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.pop(context, true);
              }
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final employeeId = await ApiConfig.getEmployeeId() ?? '';
        await HrApiService.setupPin(
            employeeId: employeeId, pin: pinCtrl.text);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('✅ PIN set up successfully'),
              backgroundColor: AppTheme.successGreen,
            ),
          );
        }
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(e.toString().replaceFirst('Exception: ', '')),
              backgroundColor: AppTheme.errorRed,
            ),
          );
        }
      }
    }
    pinCtrl.dispose();
  }

  Future<void> _showManageDevicesSheet(BuildContext context) async {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const _ManageDevicesSheet(),
    );
  }

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

  String _themeModeLabel(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.system:
        return 'Follow system setting';
      case ThemeMode.light:
        return 'Always light';
      case ThemeMode.dark:
        return 'Always dark';
    }
  }

  @override
  Widget build(BuildContext context) {
    final themeProvider = context.watch<ThemeProvider>();

    return StaffScaffold(
      title: 'Settings',
      showBottomNav: false,
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // App section
          _SectionHeader(title: 'Appearance'),
          _SettingsCard(
            children: [
              ListTile(
                leading: Icon(
                  themeProvider.themeMode == ThemeMode.dark
                      ? Icons.dark_mode
                      : themeProvider.themeMode == ThemeMode.light
                          ? Icons.light_mode
                          : Icons.brightness_auto,
                  color: AppTheme.primaryBlue,
                ),
                title: const Text('Theme'),
                subtitle: Text(_themeModeLabel(themeProvider.themeMode)),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: SegmentedButton<ThemeMode>(
                  segments: const [
                    ButtonSegment(
                      value: ThemeMode.system,
                      label: Text('System'),
                      icon: Icon(Icons.brightness_auto, size: 18),
                    ),
                    ButtonSegment(
                      value: ThemeMode.light,
                      label: Text('Light'),
                      icon: Icon(Icons.light_mode, size: 18),
                    ),
                    ButtonSegment(
                      value: ThemeMode.dark,
                      label: Text('Dark'),
                      icon: Icon(Icons.dark_mode, size: 18),
                    ),
                  ],
                  selected: {themeProvider.themeMode},
                  onSelectionChanged: (selected) {
                    themeProvider.setThemeMode(selected.first);
                  },
                ),
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
                  activeThumbColor: AppTheme.primaryBlue,
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
                  activeThumbColor: AppTheme.primaryBlue,
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
                icon: Icons.pin_outlined,
                title: 'Set Up PIN',
                subtitle: 'Set or update your 4–6 digit quick-access PIN',
                trailing: const Icon(Icons.chevron_right,
                    color: AppTheme.textSecondary),
                onTap: () => _showSetupPinDialog(context),
              ),
              const Divider(height: 1, indent: 56),
              _BiometricToggleTile(),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.devices,
                title: 'Manage Devices',
                subtitle: 'View and remove registered devices',
                trailing: const Icon(Icons.chevron_right,
                    color: AppTheme.textSecondary),
                onTap: () => _showManageDevicesSheet(context),
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
                title: 'About VHHealth Staff',
                subtitle: 'Version 1.0.0 · App info & features',
                trailing: const Icon(Icons.chevron_right,
                    color: AppTheme.textSecondary),
                onTap: () => context.push('/about'),
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

class _BiometricToggleTile extends StatefulWidget {
  @override
  State<_BiometricToggleTile> createState() => _BiometricToggleTileState();
}

class _BiometricToggleTileState extends State<_BiometricToggleTile> {
  bool _enabled = false;
  bool _loading = false;

  Future<void> _toggle(bool value) async {
    setState(() => _loading = true);
    try {
      final deviceToken = await AuthService.getDeviceToken() ?? '';
      await HrApiService.toggleBiometric(
        enabled: value,
        deviceToken: deviceToken,
      );
      setState(() => _enabled = value);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content:
                Text(value ? '✅ Biometric enabled' : 'Biometric disabled'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: const Icon(Icons.fingerprint, color: AppTheme.primaryBlue),
      title: const Text('Biometric Login',
          style: TextStyle(
              fontWeight: FontWeight.w500, color: AppTheme.textPrimary)),
      subtitle: const Text('Use fingerprint or face to sign in',
          style: TextStyle(color: AppTheme.textSecondary, fontSize: 12)),
      trailing: _loading
          ? const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2))
          : Switch(
              value: _enabled,
              activeThumbColor: AppTheme.primaryBlue,
              onChanged: _toggle,
            ),
    );
  }
}

class _ManageDevicesSheet extends StatefulWidget {
  const _ManageDevicesSheet();

  @override
  State<_ManageDevicesSheet> createState() => _ManageDevicesSheetState();
}

class _ManageDevicesSheetState extends State<_ManageDevicesSheet> {
  List<dynamic> _devices = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await HrApiService.getRegisteredDevices();
      _devices = data['devices'] as List? ?? [];
    } catch (e) {
      _error = e.toString().replaceFirst('Exception: ', '');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _removeDevice(String deviceId) async {
    try {
      await HrApiService.removeRegisteredDevice(deviceId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('✅ Device removed'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _load();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.5,
      maxChildSize: 0.85,
      minChildSize: 0.3,
      expand: false,
      builder: (_, scrollCtrl) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                const Icon(Icons.devices, color: AppTheme.primaryBlue),
                const SizedBox(width: 8),
                const Text('Registered Devices',
                    style: TextStyle(
                        fontSize: 16, fontWeight: FontWeight.bold)),
                const Spacer(),
                IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.pop(context)),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                    ? Center(child: Text(_error!))
                    : _devices.isEmpty
                        ? const Center(
                            child: Text('No devices registered',
                                style: TextStyle(
                                    color: AppTheme.textSecondary)))
                        : ListView.builder(
                            controller: scrollCtrl,
                            itemCount: _devices.length,
                            itemBuilder: (_, i) {
                              final d = _devices[i];
                              final name = d['deviceName']?.toString() ??
                                  d['name']?.toString() ??
                                  'Unknown Device';
                              final id = d['_id']?.toString() ??
                                  d['id']?.toString() ??
                                  d['deviceId']?.toString() ??
                                  '';
                              final platform =
                                  d['platform']?.toString() ?? '';
                              return ListTile(
                                leading: Icon(
                                  platform.toLowerCase().contains('ios')
                                      ? Icons.phone_iphone
                                      : Icons.phone_android,
                                  color: AppTheme.primaryBlue,
                                ),
                                title: Text(name),
                                subtitle: platform.isNotEmpty
                                    ? Text(platform,
                                        style: const TextStyle(
                                            fontSize: 12,
                                            color:
                                                AppTheme.textSecondary))
                                    : null,
                                trailing: IconButton(
                                  icon: const Icon(Icons.delete_outline,
                                      color: AppTheme.errorRed),
                                  onPressed: () => _removeDevice(id),
                                ),
                              );
                            },
                          ),
          ),
        ],
      ),
    );
  }
}
