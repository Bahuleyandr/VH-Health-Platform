// lib/core/widgets/terms_agreement_notice.dart

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:go_router/go_router.dart';

class TermsAgreementNotice extends StatelessWidget {
  const TermsAgreementNotice({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final colors = theme.colorScheme;

    TextSpan linkSpan(String text, String section) => TextSpan(
      text: text,
      style: theme.textTheme.bodySmall?.copyWith(
        decoration: TextDecoration.underline,
        color: colors.primary,
      ),
      recognizer: TapGestureRecognizer()
        ..onTap = () {
          // Ensure navigation happens after current frame
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (context.mounted) {
              context.push('/terms', extra: {'section': section});
            }
          });
        },
    );

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Text.rich(
        TextSpan(
          text: '${l10n.authByContinuingYouAgree} ',
          style: theme.textTheme.bodySmall,
          children: [
            linkSpan(l10n.authTerms, 'terms'),
            const TextSpan(text: ', '),
            linkSpan(l10n.authConditions, 'conditions'),
            TextSpan(text: ' ${l10n.authAnd} '),
            linkSpan(l10n.authPrivacyPolicy, 'privacy'),
            const TextSpan(text: '.'),
          ],
        ),
        textAlign: TextAlign.center,
      ),
    );
  }
}
