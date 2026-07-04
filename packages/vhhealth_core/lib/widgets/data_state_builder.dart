import 'package:flutter/material.dart';

/// Reusable widget that handles loading / error / empty / data states.
///
/// Eliminates the repeated `if (_loading) ... if (_error) ... if (list.isEmpty)`
/// boilerplate found in every screen.
class DataStateBuilder<T> extends StatelessWidget {
  /// Whether data is currently being loaded.
  final bool isLoading;

  /// Error message, if any. When non-null, the error state is shown.
  final String? error;

  /// The data to display.
  final List<T> data;

  /// Builder for the content when data is available and non-empty.
  final Widget Function(BuildContext context, List<T> data) builder;

  /// Called when the retry button is pressed (in error or empty states).
  final VoidCallback? onRetry;

  /// Called when the empty-state action is pressed. Falls back to [onRetry].
  final VoidCallback? onEmptyAction;

  // ── Optional customisation ─────────────────────────────────────────────

  /// Icon shown in the empty state. Defaults to [Icons.inbox_outlined].
  final IconData emptyIcon;

  /// Title shown in the empty state.
  final String emptyTitle;

  /// Subtitle shown in the empty state.
  final String emptySubtitle;

  /// Icon shown in the error state. Defaults to [Icons.error_outline].
  final IconData errorIcon;

  /// Title shown in the error state.
  final String errorTitle;

  /// Button label shown in the error state.
  final String errorActionLabel;

  /// Button label shown in the empty state when an action is available.
  final String emptyActionLabel;

  const DataStateBuilder({
    super.key,
    required this.isLoading,
    this.error,
    required this.data,
    required this.builder,
    this.onRetry,
    this.onEmptyAction,
    this.emptyIcon = Icons.inbox_outlined,
    this.emptyTitle = 'Nothing here yet',
    this.emptySubtitle = '',
    this.errorIcon = Icons.error_outline,
    this.errorTitle = 'Something went wrong',
    this.errorActionLabel = 'Retry',
    this.emptyActionLabel = 'Refresh',
  });

  @override
  Widget build(BuildContext context) {
    if (isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (error != null) {
      return _CenteredMessage(
        icon: errorIcon,
        iconColor: Theme.of(context).colorScheme.error,
        title: errorTitle,
        subtitle: error!,
        actionLabel: errorActionLabel,
        onAction: onRetry,
      );
    }

    if (data.isEmpty) {
      final emptyAction = onEmptyAction ?? onRetry;
      return _CenteredMessage(
        icon: emptyIcon,
        iconColor: Colors.grey.shade400,
        title: emptyTitle,
        subtitle: emptySubtitle,
        actionLabel: emptyAction != null ? emptyActionLabel : null,
        onAction: emptyAction,
      );
    }

    return builder(context, data);
  }
}

/// Internal centered message widget used for error and empty states.
class _CenteredMessage extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;
  final String? actionLabel;
  final VoidCallback? onAction;

  const _CenteredMessage({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 64, color: iconColor),
            const SizedBox(height: 16),
            Text(
              title,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
              textAlign: TextAlign.center,
            ),
            if (subtitle.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                subtitle,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
            ],
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 20),
              OutlinedButton.icon(
                onPressed: onAction,
                icon: const Icon(Icons.refresh, size: 18),
                label: Text(actionLabel!),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
