import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';
import '../../theme/app_theme.dart';
import '../../utils/api_error_messages.dart';

/// Centered "something went wrong" widget with a retry button.
///
/// Replaces the half-dozen ad-hoc `Column(Icon + Text + ElevatedButton)`
/// patterns scattered across screens like bed_board, appointments,
/// due_meds, patient_records, etc. The shared widget unifies tone
/// (no more raw `Exception:` prefixes leaking through), spacing, and
/// the retry button style.
///
/// Pass [onRetry] to render the retry CTA. Omit it for cases where
/// retry isn't meaningful (e.g. "you don't have permission").
///
/// [message] should be a humane summary already (no "Exception: …"
/// prefixes — strip those at the call site).
class ErrorState extends StatelessWidget {
  final String message;
  final IconData icon;
  final VoidCallback? onRetry;
  final String? retryLabel;
  const ErrorState({
    super.key,
    required this.message,
    this.icon = Icons.error_outline,
    this.onRetry,
    this.retryLabel,
  });

  @override
  Widget build(BuildContext context) {
    final strings = AppStrings.of(context);
    final displayMessage = localizedApiErrorFromRaw(
      strings,
      message,
      fallback: message,
    );
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: AppTheme.errorRed.withValues(alpha: 0.08),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 36, color: AppTheme.errorRed),
            ),
            const SizedBox(height: 16),
            Text(
              displayMessage,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 14,
                color: AppTheme.textPrimary,
                height: 1.4,
              ),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: Text(retryLabel ?? strings.actionRetry),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
