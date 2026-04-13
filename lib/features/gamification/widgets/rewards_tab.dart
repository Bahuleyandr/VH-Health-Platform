import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

class RewardsTab extends StatelessWidget {
  final List<Map<String, dynamic>> rewards;
  final bool loading;
  final Future<void> Function() onRefresh;

  const RewardsTab({
    super.key,
    required this.rewards,
    required this.loading,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    if (loading && rewards.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (rewards.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.card_giftcard,
                size: 48,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.3)),
            const SizedBox(height: 12),
            Text('Complete milestones to earn rewards!',
                style: Theme.of(context).textTheme.bodyMedium,
                textAlign: TextAlign.center),
            const SizedBox(height: 8),
            TextButton(
              onPressed: onRefresh,
              child: const Text('Refresh'),
            ),
          ],
        ),
      );
    }

    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: rewards.length,
        itemBuilder: (context, index) {
          final r = rewards[index];
          final name = r['name']?.toString() ?? r['tier']?.toString() ?? 'Reward';
          final voucherCode = r['voucherCode']?.toString() ?? '';
          final rewardDesc =
              r['rewardDescription']?.toString() ?? r['reward']?.toString() ?? '';
          final expiryStr = r['expiryDate']?.toString() ?? '';
          final redeemed = r['redeemed'] == true;

          String formattedExpiry = '';
          if (expiryStr.isNotEmpty) {
            try {
              final parsed = DateTime.tryParse(expiryStr);
              if (parsed != null) {
                formattedExpiry =
                    'Expires ${DateFormat('dd MMM yyyy').format(parsed)}';
              }
            } catch (_) {
              formattedExpiry = expiryStr;
            }
          }

          if (redeemed) return const SizedBox.shrink();

          return Card(
            elevation: 0,
            margin: const EdgeInsets.only(bottom: 10),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(Icons.card_giftcard,
                          color: const Color(0xFFFFD54F), size: 22),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          name,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (rewardDesc.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      rewardDesc,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.7),
                      ),
                    ),
                  ],
                  if (voucherCode.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 8),
                      decoration: BoxDecoration(
                        color: cs.primaryContainer.withValues(alpha: 0.4),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            voucherCode,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.bold,
                              letterSpacing: 1.5,
                            ),
                          ),
                          const SizedBox(width: 8),
                          InkWell(
                            onTap: () {
                              Clipboard.setData(
                                  ClipboardData(text: voucherCode));
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text('Voucher code copied!'),
                                  behavior: SnackBarBehavior.floating,
                                  duration: Duration(seconds: 2),
                                ),
                              );
                            },
                            child: Icon(Icons.copy,
                                size: 16,
                                color: cs.onSurface.withValues(alpha: 0.5)),
                          ),
                        ],
                      ),
                    ),
                  ],
                  if (formattedExpiry.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      formattedExpiry,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurface.withValues(alpha: 0.5),
                        fontSize: 11,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
