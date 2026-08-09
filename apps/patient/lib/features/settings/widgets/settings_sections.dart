// settings_sections.dart
import 'dart:async';

import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/config/legal_urls.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/widgets/language_dropdown.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';
import 'package:vhhealth/features/settings/controllers/settings_controller.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

List<Widget> buildSettingsSections(SettingsController c) {
  final cs = Theme.of(c.context).colorScheme;
  final txt = Theme.of(c.context).textTheme;

  return [
    _sectionTitle(c.loc.settingsEditProfile.toUpperCase(), c.context),
    _card(
      Column(
        children: [
          ListTile(
            leading: CircleAvatar(
              backgroundColor: cs.primaryContainer,
              child: Icon(Icons.person_outline, color: cs.primary),
            ),
            title: Text(c.loc.settingsEditProfile, style: txt.titleMedium),
            subtitle: Text(
              c.hospitalNumber.trim().isEmpty
                  ? c.name
                  : c.loc.settingsHospitalIdLine(c.name, c.hospitalNumber),
              style: txt.bodySmall,
            ),
            trailing: Icon(
              Icons.arrow_forward_ios,
              size: 16,
              color: cs.onSurfaceVariant,
            ),
            onTap: () {
              // ProfileEditScreen reads identity from UserProvider — no extra.
              c.context.push('/profile-edit');
            },
          ),
          const Divider(height: 1),
          ListTile(
            leading: CircleAvatar(
              backgroundColor: cs.tertiaryContainer,
              child: Icon(Icons.escalator_warning, color: cs.tertiary),
            ),
            title: Text(c.loc.settingsManageDependents, style: txt.titleMedium),
            subtitle: Text(
              c.loc.settingsManageDependentsSubtitle,
              style: txt.bodySmall,
            ),
            trailing: Icon(
              Icons.arrow_forward_ios,
              size: 16,
              color: cs.onSurfaceVariant,
            ),
            onTap: () => c.context.push('/add-dependent'),
          ),
          const Divider(height: 1),
          ListTile(
            leading: CircleAvatar(
              backgroundColor: const Color(0xFF26A69A).withAlpha(30),
              child: const Icon(
                Icons.health_and_safety,
                color: Color(0xFF26A69A),
              ),
            ),
            title: Text(c.loc.settingsHealthIdLabel, style: txt.titleMedium),
            subtitle: Text(
              c.loc.settingsHealthIdSubtitle,
              style: txt.bodySmall,
            ),
            trailing: Icon(
              Icons.arrow_forward_ios,
              size: 16,
              color: cs.onSurfaceVariant,
            ),
            onTap: () => c.context.push('/abdm'),
          ),
          const Divider(height: 1),
          ListTile(
            leading: CircleAvatar(
              backgroundColor: const Color(0xFFFF7043).withAlpha(30),
              child: const Icon(Icons.watch, color: Color(0xFFFF7043)),
            ),
            title: Text(c.loc.settingsConnectWearables, style: txt.titleMedium),
            subtitle: Text(
              c.loc.settingsConnectWearablesSubtitle,
              style: txt.bodySmall,
            ),
            trailing: const Icon(Icons.sync, size: 18),
            onTap: () async {
              final messenger = ScaffoldMessenger.of(c.context);
              final granted = await HealthSyncService.instance
                  .requestPermissions();
              if (!granted) {
                messenger.showSnackBar(
                  LiveRegionSnackBar.build(
                    message: c.loc.settingsHealthPermissionsDenied,
                  ),
                );
                return;
              }
              messenger.showSnackBar(
                LiveRegionSnackBar.build(message: c.loc.settingsSyncingHealth),
              );
              final synced = await HealthSyncService.instance.syncNow();
              await HealthSyncService.instance.startForegroundSync();
              // Register the 15-min background task so sync keeps running when
              // the app is backgrounded. Safe to call every time — existingWork
              // policy is `keep`, so re-registration is a no-op.
              final backgroundGranted = await HealthSyncService.instance
                  .requestBackgroundReadPermissionIfAvailable();
              if (backgroundGranted) {
                await HealthSyncService.enableBackgroundSync();
              }
              messenger.showSnackBar(
                LiveRegionSnackBar.build(
                  message: synced > 0
                      ? c.loc.settingsHealthDataSynced
                      : c.loc.settingsNoNewSamplesToSync,
                ),
              );
            },
          ),
        ],
      ),
    ),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsLanguage.toUpperCase(), c.context),
    _card(const LanguageDropdown()),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsAccessibility.toUpperCase(), c.context),
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

    _sectionTitle(c.loc.settingsTheme.toUpperCase(), c.context),
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
              c.tp.isDarkMode
                  ? c.loc.settingsDarkTheme
                  : c.loc.settingsLightTheme,
              style: txt.bodySmall,
            ),
            secondary: Icon(
              c.tp.isDarkMode
                  ? Icons.dark_mode_outlined
                  : Icons.light_mode_outlined,
              color: cs.primary,
            ),
            activeThumbColor: cs.primary,
          ),

          const Divider(height: 1),

          // Dynamic Colors Toggle
          SwitchListTile(
            value: c.tp.enableDynamicColors,
            onChanged: (value) {
              c.tp.toggleDynamicColors();
            },
            title: Text(c.loc.settingsDynamicColors, style: txt.titleMedium),
            subtitle: Text(
              c.loc.settingsDynamicColorsDesc,
              style: txt.bodySmall,
            ),
            secondary: Icon(Icons.palette_outlined, color: cs.primary),
            activeThumbColor: cs.primary,
          ),

          // Current Color Preview
          if (c.tp.enableDynamicColors && c.tp.dynamicAccentColor != null) ...[
            const Divider(height: 1),
            ListTile(
              leading: Icon(Icons.color_lens_outlined, color: cs.primary),
              title: Text(
                c.loc.settingsCurrentAccentColor,
                style: txt.titleMedium,
              ),
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
            subtitle: Text(c.loc.settingsResetThemeDesc, style: txt.bodySmall),
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
                      child: Text(c.loc.commonResetButton),
                    ),
                  ],
                ),
              );

              if (confirmed == true) {
                await c.tp.resetToDefaults();
                if (c.context.mounted) {
                  ScaffoldMessenger.of(c.context).showSnackBar(
                    LiveRegionSnackBar.build(
                      message: c.loc.settingsThemeResetSuccess,
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

    _sectionTitle(c.loc.settingsSecurity.toUpperCase(), c.context),
    _card(
      Column(
        children: [
          SwitchListTile(
            value: c.biometricEnabled,
            onChanged: c.biometricSupported ? c.toggleBiometric : null,
            title: Text(
              c.loc.settingsBiometricLogin,
              style: txt.titleMedium?.copyWith(
                color: c.biometricSupported
                    ? null
                    : cs.onSurface.withAlpha(128),
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
              color: c.biometricSupported
                  ? cs.primary
                  : cs.onSurface.withAlpha(76),
            ),
            activeThumbColor: cs.primary,
          ),
          const Divider(height: 1),
          ListTile(
            leading: Icon(Icons.manage_accounts_outlined, color: cs.primary),
            title: Text(c.loc.recordAccessTitle, style: txt.titleMedium),
            subtitle: Text(
              c.loc.recordAccessSettingsSubtitle,
              style: txt.bodySmall,
            ),
            trailing: Icon(
              Icons.arrow_forward_ios,
              size: 16,
              color: cs.onSurfaceVariant,
            ),
            onTap: () => c.context.push('/settings/record-access'),
          ),
          const Divider(height: 1),
          ListTile(
            leading: Icon(Icons.delete_forever_outlined, color: cs.error),
            title: Text(
              c.loc.settingsDeleteAccountTitle,
              style: txt.titleMedium?.copyWith(color: cs.error),
            ),
            subtitle: Text(c.loc.settingsDeleteAccountSubtitle),
            trailing: Icon(
              Icons.arrow_forward_ios,
              size: 16,
              color: cs.onSurfaceVariant,
            ),
            onTap: c.deleteAccount,
          ),
        ],
      ),
    ),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsLegalSection.toUpperCase(), c.context),
    _card(
      Column(
        children: [
          _legalLinkTile(
            icon: Icons.description_outlined,
            title: c.loc.commonTermsOfUse,
            subtitle: c.loc.settingsOpenTermsInBrowser,
            url: LegalUrls.termsUrl,
            c: c,
          ),
          const Divider(height: 1),
          _legalLinkTile(
            icon: Icons.privacy_tip_outlined,
            title: c.loc.commonPrivacyPolicy,
            subtitle: c.loc.settingsOpenPrivacyInBrowser,
            url: LegalUrls.privacyPolicyUrl,
            c: c,
          ),
        ],
      ),
    ),
    const SizedBox(height: 16),

    _sectionTitle(c.loc.settingsPermissionsTitle.toUpperCase(), c.context),
    _card(
      Column(
        children: [
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
        ],
      ),
    ),
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

// ✅ Fixed: Now accepts context parameter and uses theme colors
Widget _sectionTitle(String t, BuildContext context) {
  final theme = Theme.of(context);
  return Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
    child: Text(
      t,
      style: TextStyle(
        fontWeight: FontWeight.bold,
        color: theme
            .colorScheme
            .primary, // ✅ Uses theme color instead of hardcoded blue
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

Widget _legalLinkTile({
  required IconData icon,
  required String title,
  required String subtitle,
  required String url,
  required SettingsController c,
}) {
  final cs = Theme.of(c.context).colorScheme;
  return ListTile(
    leading: Icon(icon, color: cs.primary),
    title: Text(title),
    subtitle: Text(subtitle),
    trailing: Icon(Icons.open_in_new, size: 18, color: cs.onSurfaceVariant),
    onTap: () async {
      final messenger = ScaffoldMessenger.of(c.context);
      final launched = await SafeUrlLauncher.launch(
        url,
        mode: LaunchMode.externalApplication,
      );
      if (!launched) {
        messenger.showSnackBar(
          LiveRegionSnackBar.build(message: c.loc.commonCouldNotOpenLink),
        );
      }
    },
  );
}

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
            unawaited(
              c.loadAll(),
            ); // reload permission states after navigating to settings
          },
          child: Text(c.loc.settingsPermissionManage),
        ),
      ],
    ),
  );
}
