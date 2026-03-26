import 'package:flutter/material.dart';
import 'package:markdown_widget/markdown_widget.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AboutUsScreen extends StatelessWidget {
  const AboutUsScreen({super.key});

  // Hospital contact details
  static const _hospitalPhone = '+914424313948';
  static const _hospitalEmail = 'info@venkataeswara.com';
  static const _hospitalAddress = '36-A, Chamiers Road, Nandanam, Chennai - 600035';
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
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
  }

  Future<void> _callHospital() async {
    await _launchUrl('tel:$_hospitalPhone');
  }

  Future<void> _emailHospital() async {
    await _launchUrl('mailto:$_hospitalEmail?subject=Enquiry%20from%20VHHealth%20App');
  }

  Future<void> _navigateToHospital() async {
    // Try Google Maps first, fall back to generic geo URI
    final googleMapsUrl = 'https://www.google.com/maps/search/?api=1&query=$_hospitalLat,$_hospitalLng';
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
                color: cs.primary.withOpacity(0.06),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: cs.primary.withOpacity(0.15)),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  _ContactAction(
                    icon: Icons.phone,
                    label: 'Call',
                    color: Colors.green,
                    onTap: _callHospital,
                  ),
                  _ContactAction(
                    icon: Icons.navigation_rounded,
                    label: 'Navigate',
                    color: Colors.blue,
                    onTap: _navigateToHospital,
                  ),
                  _ContactAction(
                    icon: Icons.email_outlined,
                    label: 'Email',
                    color: Colors.orange,
                    onTap: _emailHospital,
                  ),
                  _ContactAction(
                    icon: Icons.emergency,
                    label: 'Emergency',
                    color: Colors.red,
                    onTap: () => _launchUrl('tel:$_hospitalPhone'),
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
                            style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            _hospitalAddress,
                            style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Tap to open in Google Maps →',
                            style: TextStyle(fontSize: 11, color: cs.primary, fontWeight: FontWeight.w500),
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
                style: theme.textTheme.bodyLarge?.copyWith(fontStyle: FontStyle.italic) ??
                    const TextStyle(fontStyle: FontStyle.italic),
                child: MarkdownBlock(
                  data: l10n.aboutUsContent,
                  config: MarkdownConfig(
                    configs: [
                      PConfig(
                        textStyle: theme.textTheme.bodyLarge ?? const TextStyle(fontSize: 16),
                      ),
                      H1Config(
                        style: theme.textTheme.headlineMedium?.copyWith(
                              fontWeight: FontWeight.bold,
                              color: cs.primary,
                            ) ??
                            const TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
                      ),
                      H2Config(
                        style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600) ??
                            const TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
                      ),
                      H3Config(
                        style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600) ??
                            const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                      ),
                      LinkConfig(
                        style: TextStyle(
                          color: cs.primary,
                          decoration: TextDecoration.underline,
                        ),
                        onTap: (url) => _launchUrl(url),
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
            backgroundColor: color.withOpacity(0.12),
            child: Icon(icon, color: color, size: 22),
          ),
          const SizedBox(height: 6),
          Text(
            label,
            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color),
          ),
        ],
      ),
    );
  }
}
