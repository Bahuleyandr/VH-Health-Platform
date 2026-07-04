import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth/generated/app_localizations.dart';

Future<void> showGuestSignInPrompt(
  BuildContext context, {
  String? featureLabel,
  String? returnTo,
}) {
  return showDialog<void>(
    context: context,
    builder: (dialogContext) {
      final theme = Theme.of(dialogContext);
      final colors = theme.colorScheme;
      final l = AppLocalizations.of(dialogContext)!;
      final label = featureLabel ?? l.guestSignInDefaultFeature;

      return AlertDialog(
        icon: Icon(Icons.lock_outline, color: colors.primary),
        title: Text(l.guestSignInTitle),
        content: Text(l.guestSignInBody(label)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: Text(l.guestSignInKeepBrowsing),
          ),
          FilledButton.icon(
            onPressed: () {
              Navigator.of(dialogContext).pop();
              if (!context.mounted) return;
              final safeReturnTo = returnTo?.trim();
              if (safeReturnTo != null && safeReturnTo.startsWith('/')) {
                context.go(
                  Uri(
                    path: '/login',
                    queryParameters: {'returnTo': safeReturnTo},
                  ).toString(),
                );
              } else {
                context.go('/login');
              }
            },
            icon: const Icon(Icons.login),
            label: Text(l.guestSignInAndReturn),
          ),
        ],
      );
    },
  );
}
