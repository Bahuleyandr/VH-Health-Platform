import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

Future<void> showGuestSignInPrompt(
  BuildContext context, {
  String featureLabel = 'this feature',
  String? returnTo,
}) {
  return showDialog<void>(
    context: context,
    builder: (dialogContext) {
      final theme = Theme.of(dialogContext);
      final colors = theme.colorScheme;

      return AlertDialog(
        icon: Icon(Icons.lock_outline, color: colors.primary),
        title: const Text('Sign in to continue'),
        content: Text(
          '$featureLabel is available for signed-in patients. '
          'You can sign in now or keep browsing as a guest.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Keep browsing'),
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
            label: const Text('Sign in and return'),
          ),
        ],
      );
    },
  );
}
