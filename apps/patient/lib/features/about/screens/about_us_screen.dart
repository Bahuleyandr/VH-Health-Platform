import 'package:flutter/material.dart';
import 'package:markdown_widget/markdown_widget.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AboutUsScreen extends StatelessWidget {
  const AboutUsScreen({super.key});

  // Hospital contact details
  static const _appointmentPhone = '+914445114511';
  static const _appointmentPhone2 = '+914445111111';
  static const _sampleCollectionPhone = '+919384543289';
  static const _sampleCollectionPhone2 = '+919500210210';
  static const _emergencyPhone = '+914445004500';
  static const _emergencyPhone2 = '+919094004500';
  static const _hospitalEmail = 'info@venkataeswara.com';
  static const _hospitalAddress =
      '36-A, Chamiers Road, Nandanam, Chennai - 600035';
  static const _hospitalLat = 13.02936;
  static const _hospitalLng = 80.24409;

  Future<void> _triggerSOS(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(l10n.authSosTriggered),
        backgroundColor: theme.colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
    await SOSService.triggerSOS();
  }

  Future<void> _launchUrl(String url) async {
    await SafeUrlLauncher.launch(url, mode: LaunchMode.externalApplication);
  }

  void _showPhoneOptions(
    BuildContext context,
    String title,
    List<(String, String)> numbers,
  ) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 16),
              ...numbers.map(
                (entry) => ListTile(
                  leading: const CircleAvatar(
                    backgroundColor: Color(0x1A007A64),
                    child: Icon(
                      Icons.phone,
                      color: Color(0xFF007A64),
                      size: 20,
                    ),
                  ),
                  title: Text(
                    entry.$1,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 1,
                    ),
                  ),
                  trailing: const Icon(Icons.call, color: Color(0xFF007A64)),
                  onTap: () {
                    Navigator.pop(context);
                    SafeUrlLauncher.launchPhone(entry.$2);
                  },
                ),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }

  // ignore: unused_element
  Future<void> _emailHospital() async {
    await _launchUrl(
      'mailto:$_hospitalEmail?subject=Enquiry%20from%20VHHealth%20App',
    );
  }

  Future<void> _navigateToHospital() async {
    // Try Google Maps first, fall back to generic geo URI
    final googleMapsUrl =
        'https://www.google.com/maps/search/?api=1&query=$_hospitalLat,$_hospitalLng';
    await _launchUrl(googleMapsUrl);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final color = FeatureScreenScaffold.featureColors['about-us']!;

    return FeatureScreenScaffold(
      title: l10n.aboutUsLabel,
      icon: Icons.info_outline,
      color: color,
      heroTag: 'about-us',
      floatingActionButton: FloatingActionButton(
        onPressed: () => _triggerSOS(context),
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        child: const Icon(Icons.favorite),
      ),
      child: SingleChildScrollView(
        child: Column(
          children: [
            // ── Contact Action Bar ──────────────────────────────
            Container(
              margin: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
              decoration: BoxDecoration(
                color: cs.primary.withValues(alpha: 0.06),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: cs.primary.withValues(alpha: 0.15)),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  _ContactAction(
                    icon: Icons.calendar_month,
                    label: 'Appointments',
                    color: Colors.teal,
                    onTap: () =>
                        _showPhoneOptions(context, 'Doctor Appointments', [
                          ('044-4511 4511', _appointmentPhone),
                          ('4511 1111', _appointmentPhone2),
                        ]),
                  ),
                  _ContactAction(
                    icon: Icons.science_outlined,
                    label: 'Home Sample',
                    color: Colors.blue,
                    onTap: () => _showPhoneOptions(
                      context,
                      'Free Home Sample Collection',
                      [
                        ('93845 43289', _sampleCollectionPhone),
                        ('95002 10210', _sampleCollectionPhone2),
                      ],
                    ),
                  ),
                  _ContactAction(
                    icon: Icons.emergency,
                    label: 'Ambulance',
                    color: Colors.red,
                    onTap: () =>
                        _showPhoneOptions(context, 'Emergency Ambulance', [
                          ('044-4500 4500', _emergencyPhone),
                          ('90940 04500', _emergencyPhone2),
                        ]),
                  ),
                  _ContactAction(
                    icon: Icons.navigation_rounded,
                    label: 'Navigate',
                    color: Colors.green,
                    onTap: _navigateToHospital,
                  ),
                ],
              ),
            ),

            // ── Address card (tap to navigate) ──────────────────
            GestureDetector(
              onTap: _navigateToHospital,
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: theme.cardColor,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: theme.dividerColor),
                ),
                child: Row(
                  children: [
                    Icon(Icons.location_on, color: cs.primary, size: 28),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Venkataeswara Hospitals',
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            _hospitalAddress,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.hintColor,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            AppLocalizations.of(context)!.aboutOpenInMaps,
                            style: TextStyle(
                              fontSize: 11,
                              color: cs.primary,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),

            const SizedBox(height: 8),

            // ── About Us Content (Markdown) ─────────────────────
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: DefaultTextStyle.merge(
                style:
                    theme.textTheme.bodyLarge?.copyWith(
                      fontStyle: FontStyle.italic,
                    ) ??
                    const TextStyle(fontStyle: FontStyle.italic),
                child: MarkdownBlock(
                  data: l10n.aboutUsContent,
                  config: MarkdownConfig(
                    configs: [
                      PConfig(
                        textStyle:
                            theme.textTheme.bodyLarge ??
                            const TextStyle(fontSize: 16),
                      ),
                      H1Config(
                        style:
                            theme.textTheme.headlineMedium?.copyWith(
                              fontWeight: FontWeight.bold,
                              color: cs.primary,
                            ) ??
                            const TextStyle(
                              fontSize: 24,
                              fontWeight: FontWeight.bold,
                            ),
                      ),
                      H2Config(
                        style:
                            theme.textTheme.titleLarge?.copyWith(
                              fontWeight: FontWeight.w600,
                            ) ??
                            const TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                      H3Config(
                        style:
                            theme.textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                            ) ??
                            const TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                      LinkConfig(
                        style: TextStyle(
                          color: cs.primary,
                          decoration: TextDecoration.underline,
                        ),
                        onTap: (url) => SafeUrlLauncher.launch(url),
                      ),
                    ],
                  ),
                ),
              ),
            ),

            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

/// Circular contact action button
class _ContactAction extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  const _ContactAction({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircleAvatar(
            radius: 24,
            backgroundColor: color.withValues(alpha: 0.12),
            child: Icon(icon, color: color, size: 22),
          ),
          const SizedBox(height: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}
