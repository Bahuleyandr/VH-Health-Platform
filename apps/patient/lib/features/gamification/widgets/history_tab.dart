import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/features/gamification/utils/tier_utils.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class HistoryTab extends StatelessWidget {
  final List<Map<String, dynamic>> history;
  final bool loading;
  final bool hasMore;
  final bool loadingMore;
  final Future<void> Function() onRefresh;
  final VoidCallback onLoadMore;

  const HistoryTab({
    super.key,
    required this.history,
    required this.loading,
    required this.hasMore,
    required this.loadingMore,
    required this.onRefresh,
    required this.onLoadMore,
  });

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    if (loading && history.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (history.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.history,
              size: 48,
              color: Theme.of(context).colorScheme.onSurface
                  .withValues(alpha: 0.3),
            ),
            const SizedBox(height: 12),
            Text(
              l.gamificationNoPointHistory,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: onRefresh,
              child: Text(l.commonRefreshButton),
            ),
          ],
        ),
      );
    }

    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isDark = theme.brightness == Brightness.dark;

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: NotificationListener<ScrollNotification>(
        onNotification: (scrollInfo) {
          if (scrollInfo.metrics.pixels >=
                  scrollInfo.metrics.maxScrollExtent - 100 &&
              hasMore &&
              !loadingMore) {
            onLoadMore();
          }
          return false;
        },
        child: ListView.builder(
          padding: const EdgeInsets.symmetric(vertical: 8),
          itemCount: history.length + (hasMore ? 1 : 0),
          itemBuilder: (context, index) {
            if (index >= history.length) {
              return const Center(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              );
            }

            final entry = history[index];
            final description =
                entry['description']?.toString() ??
                l.gamificationPointsActivity;
            final points = (entry['points'] as num?)?.toInt() ?? 0;
            final dateStr =
                entry['createdAt']?.toString() ??
                entry['date']?.toString() ??
                '';
            final activityType =
                entry['activityType']?.toString() ??
                entry['type']?.toString() ??
                '';

            final isPositive = points >= 0;
            final pointColor = isPositive
                ? (isDark ? Colors.green.shade400 : Colors.green.shade600)
                : cs.error;

            String formattedDate = '';
            if (dateStr.isNotEmpty) {
              try {
                final parsed = DateTime.tryParse(dateStr);
                if (parsed != null) {
                  formattedDate = DateFormat('dd MMM yyyy, HH:mm')
                      .format(parsed);
                }
              } catch (_) {
                formattedDate = dateStr;
              }
            }

            return Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: (isPositive ? Colors.green : cs.error).withValues(
                        alpha: 0.1,
                      ),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      activityIcon(activityType),
                      size: 16,
                      color: isPositive ? Colors.green : cs.error,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          description,
                          style: theme.textTheme.bodySmall?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        if (formattedDate.isNotEmpty)
                          Text(
                            formattedDate,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurface.withValues(alpha: 0.5),
                              fontSize: 10,
                            ),
                          ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: pointColor.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      '${isPositive ? '+' : ''}$points',
                      style: theme.textTheme.labelMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: pointColor,
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}
