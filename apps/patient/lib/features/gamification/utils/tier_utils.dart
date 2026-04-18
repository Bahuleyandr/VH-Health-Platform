import 'package:flutter/material.dart';
import 'package:lucide_icons/lucide_icons.dart';

Color getTierColor(String tier) {
  switch (tier.toLowerCase()) {
    case 'bronze':
      return const Color(0xFFCD7F32);
    case 'silver':
      return const Color(0xFF9E9E9E);
    case 'gold':
      return const Color(0xFFFFD54F);
    case 'platinum':
      return const Color(0xFF78909C);
    case 'diamond':
      return const Color(0xFF4FC3F7);
    default:
      return const Color(0xFFFFD54F);
  }
}

IconData getTierIcon(String tier) {
  switch (tier.toLowerCase()) {
    case 'bronze':
      return Icons.emoji_events;
    case 'silver':
      return Icons.emoji_events;
    case 'gold':
      return Icons.emoji_events;
    case 'platinum':
      return Icons.workspace_premium;
    case 'diamond':
      return Icons.diamond;
    default:
      return Icons.emoji_events;
  }
}

IconData activityIcon(String type) {
  switch (type.toLowerCase()) {
    case 'appointment':
    case 'visit':
      return LucideIcons.calendarCheck;
    case 'prescription':
    case 'medication':
      return LucideIcons.pill;
    case 'investigation':
    case 'lab':
      return LucideIcons.flaskConical;
    case 'steps':
    case 'walk':
      return LucideIcons.footprints;
    case 'feedback':
      return LucideIcons.messageSquare;
    case 'profile':
      return LucideIcons.user;
    case 'referral':
      return LucideIcons.userPlus;
    case 'redeem':
    case 'redeemed':
      return LucideIcons.gift;
    default:
      return LucideIcons.zap;
  }
}
