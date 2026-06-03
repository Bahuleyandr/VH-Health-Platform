import 'package:flutter/material.dart';

class MessageUnreadBadge extends StatelessWidget {
  final Widget child;
  final int unreadCount;
  final String semanticLabel;

  const MessageUnreadBadge({
    super.key,
    required this.child,
    required this.unreadCount,
    this.semanticLabel = 'unread messages',
  });

  @override
  Widget build(BuildContext context) {
    if (unreadCount <= 0) return child;

    final label = unreadCount > 99 ? '99+' : '$unreadCount';
    return Semantics(
      label: '$label $semanticLabel',
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
