import 'package:flutter/material.dart';
import 'package:markdown_widget/markdown_widget.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class AboutUsScreen extends StatelessWidget {
  const AboutUsScreen({super.key});

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
                  onTap: (url) {
                    debugPrint('Link tapped: $url');
                    // Optionally use `launchUrl` if needed
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}