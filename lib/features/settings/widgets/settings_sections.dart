import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:vhhealth/core/widgets/language_dropdown.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';
import 'package:vhhealth/features/profile/screens/profile_edit_screen.dart';
import 'package:vhhealth/features/settings/controllers/settings_controller.dart';

List<Widget> buildSettingsSections(SettingsController c) {
  final cs = Theme.of(c.context).colorScheme;
  final txt = Theme.of(c.context).textTheme;

  return [
    _sectionTitle(c.loc.settingsEditProfile.toUpperCase()),
    _card(
      ListTile(
        leading: CircleAvatar(
          backgroundColor: cs.primaryContainer,
          child: Icon(Icons.person_outline, color: cs.primary),
        ),
        title: Text(c.loc.settingsEditProfile, style: txt.titleMedium),
        subtitle: Text(c.name, style: txt.bodySmall),
        trailing: Icon(Icons.arrow_forward_ios, size: 16, color: cs.onSurfaceVariant),
        onTap: () {
          Navigator.push(
            c.context,
            MaterialPageRoute<void>(
              builder: (_) => ProfileEditScreen(phone: c.phone, name: c.name),
            ),
          );
        },
      ),
    ),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsLanguage.toUpperCase()),
    _card(const LanguageDropdown()),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsAccessibility.toUpperCase()),
    _card(
      Column(
        children: [
          ListTile(
            leading: Icon(Icons.format_size_outlined, color: cs.primary),
            title: Text(c.loc.settingsFontSize, style: txt.titleMedium),
            subtitle: Text('${c.tp.fontSize.toInt()} pt', style: txt.bodySmall),
          ),
          Slider(
            min: 12,
            max: 24,
            divisions: 6,
            value: c.tp.fontSize,
            onChanged: c.changeFontSize,
            label: '${c.tp.fontSize.toInt()} pt',
            activeColor: cs.primary,
            inactiveColor: cs.primary.withAlpha(76),
          ),
        ],
      ),
    ),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsTheme.toUpperCase()),
    _card(
      Column(
        children: [
          // Dark Mode Toggle
          SwitchListTile(
            value: c.tp.isDarkMode,
            onChanged: (value) {
              // Defer theme change to next frame
              WidgetsBinding.instance.addPostFrameCallback((_) {
                c.toggleTheme(value);
              });
            },
            title: Text(c.loc.settingsTheme, style: txt.titleMedium),
            subtitle: Text(
              c.tp.isDarkMode ? c.loc.settingsDarkTheme : c.loc.settingsLightTheme,
              style: txt.bodySmall,
            ),
            secondary: Icon(
              c.tp.isDarkMode ? Icons.dark_mode_outlined : Icons.light_mode_outlined,
              color: cs.primary,
            ),
            activeColor: cs.primary,
          ),
          
          const Divider(height: 1),
          
          // Dynamic Colors Toggle
          SwitchListTile(
            value: c.tp.enableDynamicColors,
            onChanged: (value) {
              c.tp.toggleDynamicColors();
            },
            title: Text(
              c.loc.settingsDynamicColors,
              style: txt.titleMedium,
            ),
            subtitle: Text(
              c.loc.settingsDynamicColorsDesc,
              style: txt.bodySmall,
            ),
            secondary: Icon(
              Icons.palette_outlined,
              color: cs.primary,
            ),
            activeColor: cs.primary,
          ),
          
          // Current Color Preview
          if (c.tp.enableDynamicColors && c.tp.dynamicAccentColor != null) ...[
            const Divider(height: 1),
            ListTile(
              leading: Icon(Icons.color_lens_outlined, color: cs.primary),
              title: Text(c.loc.settingsCurrentAccentColor, style: txt.titleMedium),
              subtitle: Text(
                c.loc.settingsAccentColorDesc,
                style: txt.bodySmall,
              ),
              trailing: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: c.tp.dynamicAccentColor,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: cs.outline.withAlpha(128),
                    width: 2,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: c.tp.dynamicAccentColor!.withAlpha(76),
                      blurRadius: 8,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
              ),
            ),
          ],
          
          // Reset Theme Button
          const Divider(height: 1),
          ListTile(
            leading: Icon(Icons.restore_outlined, color: cs.primary),
            title: Text(c.loc.settingsResetTheme, style: txt.titleMedium),
            subtitle: Text(
              c.loc.settingsResetThemeDesc,
              style: txt.bodySmall,
            ),
            onTap: () async {
              final confirmed = await showDialog<bool>(
                context: c.context,
                builder: (ctx) => AlertDialog(
                  title: Text(c.loc.settingsResetTheme),
                  content: Text(c.loc.settingsResetThemeConfirm),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.of(ctx).pop(false),
                      child: Text(c.loc.commonCancelButton),
                    ),
                    FilledButton(
                      onPressed: () => Navigator.of(ctx).pop(true),
                      child: Text(c.loc.commonResetButton ?? 'Reset'),
                    ),
                  ],
                ),
              );
              
              if (confirmed == true) {
                await c.tp.resetToDefaults();
                if (c.context.mounted) {
                  ScaffoldMessenger.of(c.context).showSnackBar(
                    SnackBar(
                      content: Text(c.loc.settingsThemeResetSuccess ?? 'Theme settings reset to defaults'),
                      behavior: SnackBarBehavior.floating,
                    ),
                  );
                }
              }
            },
          ),
        ],
      ),
    ),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsSecurity.toUpperCase()),
    _card(
      SwitchListTile(
        value: c.biometricEnabled,
        onChanged: c.biometricSupported ? c.toggleBiometric : null,
        title: Text(
          c.loc.settingsBiometricLogin,
          style: txt.titleMedium?.copyWith(
            color: c.biometricSupported ? null : cs.onSurface.withAlpha(128),
          ),
        ),
        subtitle: !c.biometricSupported
            ? Text(
                c.loc.settingsBiometricNotSupported,
                style: txt.bodySmall?.copyWith(color: cs.error),
              )
            : null,
        secondary: Icon(
          Icons.fingerprint_outlined,
          color: c.biometricSupported ? cs.primary : cs.onSurface.withAlpha(76),
        ),
        activeColor: cs.primary,
      ),
    ),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsPermissionsTitle.toUpperCase()),
    _card(Column(children: [
      _permissionTile(
        Icons.calendar_today_outlined,
        c.loc.settingsPermissionCalendar,
        c.loc.settingsPermissionCalendarDesc,
        c.calendarGranted,
        c,
      ),
      _permissionTile(
        Icons.location_on_outlined,
        c.loc.settingsPermissionLocation,
        c.loc.settingsPermissionLocationDesc,
        c.locationGranted,
        c,
      ),
      _permissionTile(
        Icons.camera_alt_outlined,
        c.loc.settingsPermissionCamera,
        c.loc.settingsPermissionCameraDesc,
        c.cameraGranted,
        c,
      ),
    ])),
    const SizedBox(height: 24),

    Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: LogoutButton(
        icon: Icons.logout_outlined,
        label: c.loc.settingsLogout,
      ),
    ),
    const SizedBox(height: 80),
  ];
}

Widget _sectionTitle(String t) {
  return Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
    child: Text(
      t,
      style: const TextStyle(
        fontWeight: FontWeight.bold,
        color: Colors.blue,
        letterSpacing: .8,
      ),
    ),
  );
}

Widget _card(Widget child) => Card(
      elevation: 1,
      margin: const EdgeInsets.symmetric(horizontal: 8),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: child,
    );

Widget _permissionTile(
  IconData icon,
  String title,
  String subtitle,
  bool granted,
  SettingsController c,
) {
  return ListTile(
    leading: Icon(icon, color: Theme.of(c.context).colorScheme.primary),
    title: Text(title),
    subtitle: Text(subtitle),
    trailing: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(granted ? '✅' : '❌', style: const TextStyle(fontSize: 18)),
        const SizedBox(width: 8),
        TextButton(
          onPressed: () async {
            await openAppSettings();
            c.loadAll(); // reload permission states after navigating to settings
          },
          child: Text(c.loc.settingsPermissionManage),
        ),
      ],
    ),
  );
}