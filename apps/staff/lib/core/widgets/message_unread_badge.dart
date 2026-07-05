import 'package:flutter/material.dart';

import '../../l10n/app_strings.dart';

class MessageUnreadBadge extends StatelessWidget {
  final Widget child;
  final int unreadCount;
  final String? semanticLabel;

  const MessageUnreadBadge({
    super.key,
    required this.child,
    required this.unreadCount,
    this.semanticLabel,
  });

  @override
  Widget build(BuildContext context) {
    if (unreadCount <= 0) return child;

    final strings = AppStrings.of(context);
    final label = unreadCount > 99 ? '99+' : '$unreadCount';
    final effectiveSemanticLabel =
        semanticLabel ??
        strings.lookup('s4.lib.message_unread_badge.unread_messages');
    return Semantics(
      label: strings.format('s4.dynamic.message_unread_badge.count_label', {
        'count': label,
        'label': effectiveSemanticLabel,
      }),
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: [
          child,
          Positioned(
            right: -9,
            top: -7,
            child: Container(
              constraints: const BoxConstraints(minWidth: 18, minHeight: 18),
              padding: const EdgeInsets.symmetric(horizontal: 4),
              decoration: BoxDecoration(
                color: Colors.red.shade700,
                borderRadius: BorderRadius.circular(9),
                border: Border.all(
                  color: Theme.of(context).colorScheme.surface,
                  width: 1.5,
                ),
              ),
              child: Center(
                child: Text(
                  label,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    height: 1,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
