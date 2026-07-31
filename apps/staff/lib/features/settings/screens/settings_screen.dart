import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../../core/config/api_config.dart';
import '../../../core/providers/locale_provider.dart';
import '../../../core/providers/theme_provider.dart';
import '../../../core/utils/font_scale.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_flow.dart';
import '../../../core/widgets/online_only_action_state.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  Future<void> _showSetupPinDialog(BuildContext context) async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    final s = AppStrings.of(context);
    final pinCtrl = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(s.settingsSetupPinDialogTitle),
        content: Form(
          key: formKey,
          child: TextFormField(
            controller: pinCtrl,
            obscureText: true,
            keyboardType: TextInputType.number,
            maxLength: 6,
            decoration: InputDecoration(
              labelText: s.settingsSetupPinDialogLabel,
              prefixIcon: const ExcludeSemantics(
                child: Icon(Icons.pin_outlined),
              ),
            ),
            validator: (v) {
              if (v == null || v.isEmpty) return s.loginPinRequired;
              if (v.length < 4) return s.loginPinMinDigits;
              return null;
            },
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.pop(context, true);
              }
            },
            child: Text(s.actionSave),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      try {
        final employeeId = await ApiConfig.getEmployeeId() ?? '';
        await HrApiService.setupPin(employeeId: employeeId, pin: pinCtrl.text);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(s.settingsSetupPinSuccess),
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

  Future<void> _showChangePasswordDialog(BuildContext context) async {
    if (!OnlineOnlyActionGuard.require(context)) return;
    final s = AppStrings.of(context);
    final currentCtrl = TextEditingController();
    final newCtrl = TextEditingController();
    final confirmCtrl = TextEditingController();
    final formKey = GlobalKey<FormState>();

    final values = await showDialog<Map<String, String>>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(s.settingsChangePasswordDialogTitle),
        content: Form(
          key: formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: currentCtrl,
                obscureText: true,
                decoration: InputDecoration(
                  labelText: s.settingsChangePasswordCurrent,
                  prefixIcon: const ExcludeSemantics(
                    child: Icon(Icons.lock_outline),
                  ),
                ),
                validator: (v) => v == null || v.isEmpty
                    ? s.settingsChangePasswordCurrent
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: newCtrl,
                obscureText: true,
                decoration: InputDecoration(
                  labelText: s.settingsChangePasswordNew,
                  prefixIcon: const ExcludeSemantics(
                    child: Icon(Icons.password_outlined),
                  ),
                ),
                validator: (v) {
                  if (v == null || v.isEmpty) {
                    return s.settingsChangePasswordNew;
                  }
                  if (v.length < 8) {
                    return 'Password must be at least 8 characters';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: confirmCtrl,
                obscureText: true,
                decoration: InputDecoration(
                  labelText: s.settingsChangePasswordConfirm,
                  prefixIcon: const ExcludeSemantics(
                    child: Icon(Icons.verified_user_outlined),
                  ),
                ),
                validator: (v) {
                  if (v != newCtrl.text) {
                    return s.settingsChangePasswordMismatch;
                  }
                  return null;
                },
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(s.actionCancel),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState!.validate()) {
                Navigator.pop(context, {
                  'currentPassword': currentCtrl.text,
                  'newPassword': newCtrl.text,
                });
              }
            },
            child: Text(s.actionSave),
          ),
        ],
      ),
    );

    currentCtrl.dispose();
    newCtrl.dispose();
    confirmCtrl.dispose();

    if (values == null || !context.mounted) return;
    try {
      await HrApiService.changeOwnPassword(
        currentPassword: values['currentPassword'] ?? '',
        newPassword: values['newPassword'] ?? '',
      );
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.settingsChangePasswordSuccess),
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

  Future<void> _showManageDevicesSheet(BuildContext context) async {
    if (!OnlineOnlyActionGuard.require(context)) return;
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
    final s = AppStrings.of(context);
    await LogoutFlow.start(
      context,
      confirmationTitle: s.settingsLogoutDialogTitle,
      confirmationBody: s.settingsLogoutDialogBody,
    );
  }

  String _themeModeLabel(BuildContext context, ThemeMode mode) {
    final s = AppStrings.of(context);
    switch (mode) {
      case ThemeMode.system:
        return s.settingsThemeSubtitleSystem;
      case ThemeMode.light:
        return s.settingsThemeSubtitleLight;
      case ThemeMode.dark:
        return s.settingsThemeSubtitleDark;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final themeProvider = context.watch<ThemeProvider>();

    return StaffScaffold(
      title: s.settingsTitle,
      showBottomNav: false,
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // App section
          _SectionHeader(title: s.settingsSectionAppearance),
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
                title: Text(s.settingsThemeTitle),
                subtitle: Text(
                  _themeModeLabel(context, themeProvider.themeMode),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: SegmentedButton<ThemeMode>(
                  segments: [
                    ButtonSegment(
                      value: ThemeMode.system,
                      label: Text(s.settingsThemeSystem),
                      icon: const Icon(Icons.brightness_auto, size: 18),
                    ),
                    ButtonSegment(
                      value: ThemeMode.light,
                      label: Text(s.settingsThemeLight),
                      icon: const Icon(Icons.light_mode, size: 18),
                    ),
                    ButtonSegment(
                      value: ThemeMode.dark,
                      label: Text(s.settingsThemeDark),
                      icon: const Icon(Icons.dark_mode, size: 18),
                    ),
                  ],
                  selected: {themeProvider.themeMode},
                  onSelectionChanged: (selected) {
                    themeProvider.setThemeMode(selected.first);
                  },
                ),
              ),
              const Divider(height: 1, indent: 56),
              // Font size (roadmap E3) — composed with the OS text scale
              // in main.dart; 16 pt = neutral.
              ListTile(
                leading: const Icon(
                  Icons.format_size,
                  color: AppTheme.primaryBlue,
                ),
                title: Text(s.settingsFontSize),
                subtitle: Text(s.settingsFontSizeSubtitle),
                trailing: Text(
                  '${themeProvider.fontSize.toInt()} pt',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                child: Slider(
                  value: themeProvider.fontSize,
                  min: kMinFontPt,
                  max: kMaxFontPt,
                  divisions: (kMaxFontPt - kMinFontPt).toInt(),
                  label: '${themeProvider.fontSize.toInt()} pt',
                  onChanged: (v) => themeProvider.setFontSize(v),
                ),
              ),
              const Divider(height: 1, indent: 56),
              // Language override (roadmap E2) — null follows the device
              // locale; persisted via LocaleProvider.
              Builder(
                builder: (context) {
                  final localeProvider = context.watch<LocaleProvider>();
                  final current = localeProvider.locale?.languageCode;
                  return ListTile(
                    leading: const Icon(
                      Icons.translate,
                      color: AppTheme.primaryBlue,
                    ),
                    title: Text(s.settingsLanguage),
                    subtitle: Text(
                      current == null
                          ? s.settingsLanguageSystem
                          : LocaleProvider.languageNames[current] ?? current,
                    ),
                    trailing: DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        value: current ?? 'system',
                        items: [
                          DropdownMenuItem(
                            value: 'system',
                            child: Text(s.settingsLanguageSystem),
                          ),
                          for (final entry
                              in LocaleProvider.languageNames.entries)
                            DropdownMenuItem(
                              value: entry.key,
                              child: Text(entry.value),
                            ),
                        ],
                        onChanged: (code) => localeProvider.setLanguage(code),
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
          const SizedBox(height: 16),

          _SectionHeader(title: s.settingsSectionNotifications),
          _SettingsCard(
            children: [
              _SettingsTile(
                icon: Icons.notifications_outlined,
                title: s.settingsPushNotifications,
                subtitle: s.settingsPushNotificationsSubtitle,
                trailing: Switch(
                  value: true,
                  activeThumbColor: AppTheme.primaryBlue,
                  onChanged: (_) {},
                ),
              ),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.schedule,
                title: s.settingsShiftReminders,
                subtitle: s.settingsShiftRemindersSubtitle,
                trailing: Switch(
                  value: true,
                  activeThumbColor: AppTheme.primaryBlue,
                  onChanged: (_) {},
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),

          _SectionHeader(title: s.settingsSectionSecurity),
          _SettingsCard(
            children: [
              OnlineOnlyActionState(
                builder: (context, isOnline, offlineMessage) => _SettingsTile(
                  icon: Icons.pin_outlined,
                  title: s.settingsSetupPin,
                  subtitle: isOnline
                      ? s.settingsSetupPinSubtitle
                      : offlineMessage,
                  trailing: Icon(
                    Icons.chevron_right,
                    color: AppTheme.textSecondary,
                  ),
                  onTap: isOnline ? () => _showSetupPinDialog(context) : null,
                ),
              ),
              const Divider(height: 1, indent: 56),
              OnlineOnlyActionState(
                builder: (context, isOnline, offlineMessage) => _SettingsTile(
                  icon: Icons.lock_reset_outlined,
                  title: s.settingsChangePassword,
                  subtitle: isOnline
                      ? s.settingsChangePasswordSubtitle
                      : offlineMessage,
                  trailing: Icon(
                    Icons.chevron_right,
                    color: AppTheme.textSecondary,
                  ),
                  onTap: isOnline
                      ? () => _showChangePasswordDialog(context)
                      : null,
                ),
              ),
              const Divider(height: 1, indent: 56),
              _BiometricToggleTile(),
              const Divider(height: 1, indent: 56),
              OnlineOnlyActionState(
                builder: (context, isOnline, offlineMessage) => _SettingsTile(
                  icon: Icons.devices,
                  title: s.settingsManageDevices,
                  subtitle: isOnline
                      ? s.settingsManageDevicesSubtitle
                      : offlineMessage,
                  trailing: Icon(
                    Icons.chevron_right,
                    color: AppTheme.textSecondary,
                  ),
                  onTap: isOnline
                      ? () => _showManageDevicesSheet(context)
                      : null,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),

          _SectionHeader(title: s.settingsSectionQuickLinks),
          _SettingsCard(
            children: [
              _SettingsTile(
                icon: Icons.person_outlined,
                title: s.settingsQuickLinkProfile,
                subtitle: s.settingsQuickLinkProfileSubtitle,
                trailing: Icon(
                  Icons.chevron_right,
                  color: AppTheme.textSecondary,
                ),
                onTap: () => context.push('/profile'),
              ),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.fingerprint,
                title: s.settingsQuickLinkAttendance,
                subtitle: s.settingsQuickLinkAttendanceSubtitle,
                trailing: Icon(
                  Icons.chevron_right,
                  color: AppTheme.textSecondary,
                ),
                onTap: () => context.push('/attendance'),
              ),
              const Divider(height: 1, indent: 56),
              _SettingsTile(
                icon: Icons.event_available,
                title: s.settingsQuickLinkLeave,
                subtitle: s.settingsQuickLinkLeaveSubtitle,
                trailing: Icon(
                  Icons.chevron_right,
                  color: AppTheme.textSecondary,
                ),
                onTap: () => context.push('/leave'),
              ),
            ],
          ),
          const SizedBox(height: 16),

          _SectionHeader(title: s.settingsSectionAbout),
          _SettingsCard(
            children: [
              _SettingsTile(
                icon: Icons.info_outlined,
                title: s.settingsAboutTitle,
                subtitle: s.settingsAboutSubtitle,
                trailing: Icon(
                  Icons.chevron_right,
                  color: AppTheme.textSecondary,
                ),
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
              label: Text(s.actionLogout),
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
        style: TextStyle(
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
    return Card(child: Column(children: children));
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
      title: Text(
        title,
        style: TextStyle(
          fontWeight: FontWeight.w500,
          color: AppTheme.textPrimary,
        ),
      ),
      subtitle: subtitle != null
          ? Text(
              subtitle!,
              style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
            )
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
    if (!OnlineOnlyActionGuard.require(context)) return;
    setState(() => _loading = true);
    try {
      final deviceToken = await AuthService.getDeviceToken() ?? '';
      await HrApiService.toggleBiometric(
        enabled: value,
        deviceToken: deviceToken,
      );
      setState(() => _enabled = value);
      if (mounted) {
        final s = AppStrings.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              value ? s.settingsBiometricEnabled : s.settingsBiometricDisabled,
            ),
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
    final s = AppStrings.of(context);
    return ListTile(
      leading: const Icon(Icons.fingerprint, color: AppTheme.primaryBlue),
      title: Text(
        s.settingsBiometricTitle,
        style: TextStyle(
          fontWeight: FontWeight.w500,
          color: AppTheme.textPrimary,
        ),
      ),
      subtitle: Text(
        s.settingsBiometricSubtitle,
        style: TextStyle(color: AppTheme.textSecondary, fontSize: 12),
      ),
      trailing: OnlineOnlyActionState(
        builder: (context, isOnline, offlineMessage) => Tooltip(
          message: isOnline ? '' : offlineMessage,
          child: _loading
              ? const SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Switch(
                  value: _enabled,
                  activeThumbColor: AppTheme.primaryBlue,
                  onChanged: isOnline ? _toggle : null,
                ),
        ),
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
    if (!OnlineOnlyActionGuard.require(context)) return;
    try {
      await HrApiService.removeRegisteredDevice(deviceId);
      if (mounted) {
        final s = AppStrings.of(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.settingsDeviceRemoved),
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
    final s = AppStrings.of(context);
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
                Text(
                  s.settingsRegisteredDevices,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.pop(context),
                ),
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
                ? Center(
                    child: Text(
                      s.settingsNoDevices,
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  )
                : ListView.builder(
                    controller: scrollCtrl,
                    itemCount: _devices.length,
                    itemBuilder: (_, i) {
                      final d = _devices[i];
                      final name =
                          d['deviceName']?.toString() ??
                          d['name']?.toString() ??
                          s.settingsUnknownDevice;
                      final id =
                          d['_id']?.toString() ??
                          d['id']?.toString() ??
                          d['deviceId']?.toString() ??
                          '';
                      final platform = d['platform']?.toString() ?? '';
                      return ListTile(
                        leading: Icon(
                          platform.toLowerCase().contains('ios')
                              ? Icons.phone_iphone
                              : Icons.phone_android,
                          color: AppTheme.primaryBlue,
                        ),
                        title: Text(name),
                        subtitle: platform.isNotEmpty
                            ? Text(
                                platform,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: AppTheme.textSecondary,
                                ),
                              )
                            : null,
                        trailing: OnlineOnlyActionState(
                          builder: (context, isOnline, offlineMessage) =>
                              Tooltip(
                                message: isOnline ? '' : offlineMessage,
                                child: IconButton(
                                  icon: const Icon(
                                    Icons.delete_outline,
                                    color: AppTheme.errorRed,
                                  ),
                                  onPressed: isOnline
                                      ? () => _removeDevice(id)
                                      : null,
                                ),
                              ),
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
