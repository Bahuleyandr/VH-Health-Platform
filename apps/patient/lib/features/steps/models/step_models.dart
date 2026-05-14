// Data models for the Step Challenge feature. Extracted from
// step_challenge_screen.dart — pure Dart, no Flutter imports.

class StepProfile {
  final String displayName;
  final String displayColor;
  final int dailyGoal;
  final bool optedIn;

  const StepProfile({
    required this.displayName,
    required this.displayColor,
    required this.dailyGoal,
    required this.optedIn,
  });

  factory StepProfile.fromJson(Map<String, dynamic> j) => StepProfile(
    displayName: j['display_name']?.toString() ?? '',
    displayColor: j['display_color']?.toString() ?? '#2196F3',
    dailyGoal: (j['daily_goal'] as num?)?.toInt() ?? 8000,
    optedIn: j['opted_in'] as bool? ?? true,
  );
}

class DailyRow {
  final String date;
  final int steps;
  final double distanceMeters;
  const DailyRow({
    required this.date,
    required this.steps,
    required this.distanceMeters,
  });

  factory DailyRow.fromJson(Map<String, dynamic> j) => DailyRow(
    date: j['date']?.toString() ?? '',
    steps: (j['steps'] as num?)?.toInt() ?? 0,
    distanceMeters: (j['distanceMeters'] as num?)?.toDouble() ?? 0,
  );
}

class WeeklyRow {
  final String weekStart;
  final int avgSteps;
  final double avgDistanceMeters;
  const WeeklyRow({
    required this.weekStart,
    required this.avgSteps,
    required this.avgDistanceMeters,
  });

  factory WeeklyRow.fromJson(Map<String, dynamic> j) => WeeklyRow(
    weekStart: j['weekStart']?.toString() ?? '',
    avgSteps: (j['avgSteps'] as num?)?.toInt() ?? 0,
    avgDistanceMeters: (j['avgDistanceMeters'] as num?)?.toDouble() ?? 0,
  );
}

class MonthlyRow {
  final String month;
  final int avgSteps;
  final double avgDistanceMeters;
  const MonthlyRow({
    required this.month,
    required this.avgSteps,
    required this.avgDistanceMeters,
  });

  factory MonthlyRow.fromJson(Map<String, dynamic> j) => MonthlyRow(
    month: j['month']?.toString() ?? '',
    avgSteps: (j['avgSteps'] as num?)?.toInt() ?? 0,
    avgDistanceMeters: (j['avgDistanceMeters'] as num?)?.toDouble() ?? 0,
  );
}

class LeaderEntry {
  final String displayName;
  final String displayColor;
  final int totalSteps;
  final double totalDistanceMeters;
  final int rank;
  final bool isMe;

  const LeaderEntry({
    required this.displayName,
    required this.displayColor,
    required this.totalSteps,
    required this.totalDistanceMeters,
    required this.rank,
    required this.isMe,
  });

  factory LeaderEntry.fromJson(Map<String, dynamic> j) => LeaderEntry(
    displayName: j['displayName']?.toString() ?? 'Anonymous',
    displayColor: j['displayColor']?.toString() ?? '#2196F3',
    totalSteps: (j['totalSteps'] as num?)?.toInt() ?? 0,
    totalDistanceMeters: (j['totalDistanceMeters'] as num?)?.toDouble() ?? 0,
    rank: (j['rank'] as num?)?.toInt() ?? 0,
    isMe: j['isMe'] as bool? ?? false,
  );
}

class Reward {
  final String rewardType;
  final String description;
  final bool isApplied;

  const Reward({
    required this.rewardType,
    required this.description,
    required this.isApplied,
  });

  factory Reward.fromJson(Map<String, dynamic> j) => Reward(
    rewardType: j['reward_type']?.toString() ?? '',
    description: j['description']?.toString() ?? '',
    isApplied: j['is_applied'] as bool? ?? false,
  );

  String get displayText {
    switch (rewardType) {
      case 'TOP1_MONTH':
        return '🥇 #1 this month! Free consultation + 10% off pharmacy & investigations';
      case 'TOP2_3_MONTH':
        return '🥈 Top 3! 10% off pharmacy & investigations';
      case 'TOP10PCT_MONTH':
        return '🏅 Top 10%! 5% off pharmacy';
      case 'CONSISTENCY_MONTH':
        return '📅 20+ active days! 5% off pharmacy';
      case 'STREAK_7':
        return '🔥 7-day streak!';
      case 'STREAK_30':
        return '🔥 30-day streak!';
      case 'STREAK_90':
        return '🔥 90-day streak!';
      case 'DIST_100KM':
        return '🏅 100km milestone!';
      case 'DIST_500KM':
        return '🏅 500km milestone!';
      case 'DIST_1000KM':
        return '🏅 1000km milestone!';
      default:
        return description.isNotEmpty ? description : rewardType;
    }
  }
}
