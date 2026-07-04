import 'package:go_router/go_router.dart';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:markdown_widget/markdown_widget.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/config/legal_urls.dart';
import 'package:vhhealth/core/utils/safe_url_launcher.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/generated/app_localizations_en.dart';

class TermsDisclaimerScreen extends StatefulWidget {
  final String? section;
  const TermsDisclaimerScreen({super.key, this.section});

  @override
  State<TermsDisclaimerScreen> createState() => _TermsDisclaimerScreenState();
}

class _TermsDisclaimerScreenState extends State<TermsDisclaimerScreen> {
  final _scrollCtrl = ScrollController();
  final _termsKey = GlobalKey();
  final _conditionsKey = GlobalKey();
  final _privacyKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.section != null) {
        _scrollTo(widget.section!);
      }
    });
  }

  void _scrollTo(String section) {
    // Add a check to ensure the widget is mounted and laid out
    if (!mounted) return;

    // Delay execution to next frame to ensure layout is complete
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;

      final key = switch (section.toLowerCase()) {
        'terms' => _termsKey,
        'conditions' => _conditionsKey,
        'privacy' => _privacyKey,
        _ => null,
      };

      final context = key?.currentContext;
      if (context != null) {
        Scrollable.ensureVisible(
          context,
          duration: const Duration(milliseconds: 500),
          curve: Curves.easeInOut,
          alignment: 0.1,
        );
      }
    });
  }

  Widget _sectionHeader(String text, {GlobalKey? key}) => Container(
    key: key,
    padding: const EdgeInsets.only(top: 24, bottom: 8),
    child: Text(
      text,
      style: Theme.of(
        context,
      ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
    ),
  );

  Widget _buildMarkdownSection(String? data) {
    final content = (data ?? '').trim();
    return MarkdownBlock(
      data: content.isNotEmpty ? content : 'No content available.',
      config: MarkdownConfig(
        configs: [
          const PConfig(),
          const H1Config(),
          const H2Config(),
          const H3Config(),
          LinkConfig(onTap: _openExternalUrl),
          const BlockquoteConfig(),
        ],
      ),
    );
  }

  Future<void> _openExternalUrl(String url) async {
    final launched = await SafeUrlLauncher.launch(
      url,
      mode: LaunchMode.externalApplication,
    );
    if (!launched && mounted) {
      final l = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l.commonCouldNotOpenLink)));
    }
  }

  Widget _externalLegalLink({
    required IconData icon,
    required String label,
    required String url,
  }) {
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton.icon(
        icon: Icon(icon),
        label: Text(label),
        onPressed: () => _openExternalUrl(url),
      ),
    );
  }

  String _legalBody(String section, AppLocalizations l10n) {
    final fallback = AppLocalizationsEn();
    final value = switch (section) {
      'terms' => l10n.termsBody,
      'conditions' => l10n.conditionsBody,
      'privacy' => l10n.privacyBody,
      _ => '',
    }.trim();
    if (value.isNotEmpty) return value;

    return switch (section) {
      'terms' => fallback.termsBody,
      'conditions' => fallback.conditionsBody,
      'privacy' => fallback.privacyBody,
      _ => '',
    };
  }

  Widget _navigationChip(String label, String section) {
    return ActionChip(
      label: Text(label),
      onPressed: () => _scrollTo(section),
      backgroundColor: Theme.of(context).primaryColor.withValues(alpha: 0.1),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.commonTermsConditionsDisclaimerTitle),
        elevation: 0,
      ),
      body: LogoBackground(
        child: SafeArea(
          child: Column(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      _navigationChip(l10n.commonTermsOfUse, 'terms'),
                      const SizedBox(width: 8),
                      _navigationChip(l10n.commonConditions, 'conditions'),
                      const SizedBox(width: 8),
                      _navigationChip(l10n.commonPrivacyPolicy, 'privacy'),
                    ],
                  ),
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView(
                  shrinkWrap: true,
                  physics: const AlwaysScrollableScrollPhysics(),
                  controller: _scrollCtrl,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  children: [
                    _sectionHeader(l10n.commonTermsOfUse, key: _termsKey),
                    _externalLegalLink(
                      icon: Icons.open_in_new,
                      label: 'Open terms in browser',
                      url: LegalUrls.termsUrl,
                    ),
                    _buildMarkdownSection(_legalBody('terms', l10n)),
                    _sectionHeader(l10n.commonConditions, key: _conditionsKey),
                    _buildMarkdownSection(_legalBody('conditions', l10n)),
                    _sectionHeader(l10n.commonPrivacyPolicy, key: _privacyKey),
                    _externalLegalLink(
                      icon: Icons.open_in_new,
                      label: 'Open privacy policy in browser',
                      url: LegalUrls.privacyPolicyUrl,
                    ),
                    _buildMarkdownSection(_legalBody('privacy', l10n)),
                    const SizedBox(height: 40),
                    Center(
                      child: ElevatedButton.icon(
                        icon: const Icon(Icons.arrow_back),
                        label: Text(l10n.commonBackToLogin),
                        onPressed: () => context.pop(),
                      ),
                    ),
                    const SizedBox(height: 24),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _scrollCtrl.dispose();
    super.dispose();
  }
}
