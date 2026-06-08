// lib/features/gamification/screens/health_points_screen.dart
// Health Points — tier progress, milestones, rewards, and point history.
// Tab UI lives in lib/features/gamification/widgets/*_tab.dart; this file
// owns data fetching + orchestration only.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/gamification/widgets/achievement_grid.dart';
import 'package:vhhealth/features/gamification/widgets/history_tab.dart';
import 'package:vhhealth/features/gamification/widgets/milestones_tab.dart';
import 'package:vhhealth/features/gamification/widgets/overview_tab.dart';
import 'package:vhhealth/features/gamification/widgets/rewards_tab.dart';
import 'package:vhhealth/generated/app_localizations.dart';

class HealthPointsScreen extends StatefulWidget {
  const HealthPointsScreen({super.key});

  @override
  State<HealthPointsScreen> createState() => _HealthPointsScreenState();
}

class _HealthPointsScreenState extends State<HealthPointsScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  // ── Overview data ──
  bool _loadingSummary = true;
  Map<String, dynamic>? _summary;

  // ── Central health hub stats ──
  bool _loadingHubStats = true;
  Map<String, dynamic>? _stepProfile;
  Map<String, dynamic>? _stepHistory;
  Map<String, dynamic>? _wellnessScore;
  Map<String, dynamic>? _syncStatus;

  // ── Milestones data ──
  bool _loadingMilestones = false;
  List<Map<String, dynamic>> _milestones = [];
  final Set<String> _claimingIds = {};

  // ── Rewards (My Rewards) ──
  bool _loadingRewards = false;
  List<Map<String, dynamic>> _rewards = [];

  // ── History data ──
  bool _loadingHistory = false;
  List<Map<String, dynamic>> _history = [];
  int _historyPage = 1;
  bool _hasMoreHistory = true;
  bool _loadingMoreHistory = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 5, vsync: this);
    _tabController.addListener(_onTabChanged);
    _fetchSummary();
    _fetchHubStats();
  }

  @override
  void dispose() {
    _tabController.removeListener(_onTabChanged);
    _tabController.dispose();
    super.dispose();
  }

  void _onTabChanged() {
    if (!_tabController.indexIsChanging) return;
    switch (_tabController.index) {
      case 0:
        if (_summary == null) _fetchSummary();
        break;
      case 1:
        if (_milestones.isEmpty && !_loadingMilestones) _fetchMilestones();
        break;
      case 2:
        // AchievementGrid self-fetches; no-op here.
        break;
      case 3:
        if (_rewards.isEmpty) _fetchRewards();
        break;
      case 4:
        if (_history.isEmpty) _fetchHistory();
        break;
    }
  }

  // ─── Data fetching ───────────────────────────────────────────────────────

  Future<void> _fetchHubStats() async {
    setState(() => _loadingHubStats = true);
    try {
      final results = await Future.wait([
        ApiClient.get('/steps/profile'),
        ApiClient.get('/steps/history'),
        ApiClient.get('/gamification/wellness-score'),
        ApiClient.get('/steps/sync-status'),
      ]);
      if (!mounted) return;

      setState(() {
        _stepProfile = results[0].isSuccess
            ? Map<String, dynamic>.from(results[0].dataAsMap())
            : null;
        _stepHistory = results[1].isSuccess
            ? Map<String, dynamic>.from(results[1].dataAsMap())
            : null;
        _wellnessScore = results[2].isSuccess
            ? Map<String, dynamic>.from(results[2].dataAsMap())
            : null;
        _syncStatus = results[3].isSuccess
            ? Map<String, dynamic>.from(results[3].dataAsMap())
            : null;
      });
    } catch (e) {
      debugPrint('fetchHubStats error: $e');
    } finally {
      if (mounted) setState(() => _loadingHubStats = false);
    }
  }

  Future<void> _fetchSummary() async {
    setState(() => _loadingSummary = true);
    try {
      final resp = await ApiClient.get('/gamification/summary');
      if (!mounted) return;
      if (resp.isSuccess && resp.data is Map) {
        setState(() => _summary = Map<String, dynamic>.from(resp.data as Map));
      }
    } catch (e) {
      debugPrint('fetchSummary error: $e');
    } finally {
      if (mounted) setState(() => _loadingSummary = false);
    }
  }

  Future<void> _fetchMilestones() async {
    setState(() => _loadingMilestones = true);
    try {
      final resp = await ApiClient.get('/gamification/milestones');
      if (!mounted) return;
      if (resp.isSuccess) {
        final list = resp.data is List
            ? resp.data as List
            : (resp.data is Map
                  ? (resp.data['milestones'] as List? ?? [])
                  : []);
        setState(() {
          _milestones = list
              .map((e) => Map<String, dynamic>.from(e as Map))
              .toList();
        });
      }
    } catch (e) {
      debugPrint('fetchMilestones error: $e');
    } finally {
      if (mounted) setState(() => _loadingMilestones = false);
    }
  }

  Future<void> _fetchRewards() async {
    setState(() => _loadingRewards = true);
    try {
      final resp = await ApiClient.get('/gamification/milestones');
      if (!mounted) return;
      if (resp.isSuccess) {
        final list = resp.data is List
            ? resp.data as List
            : (resp.data is Map
                  ? (resp.data['milestones'] as List? ?? [])
                  : []);
        // Filter to only CLAIMED milestones with active vouchers
        final claimed = list
            .map((e) => Map<String, dynamic>.from(e as Map))
            .where((m) {
              final status = m['status']?.toString().toUpperCase() ?? '';
              return status == 'CLAIMED';
            })
            .toList();
        setState(() => _rewards = claimed);
      }
    } catch (e) {
      debugPrint('fetchRewards error: $e');
    } finally {
      if (mounted) setState(() => _loadingRewards = false);
    }
  }

  Future<void> _fetchHistory({bool loadMore = false}) async {
    if (loadMore) {
      if (_loadingMoreHistory || !_hasMoreHistory) return;
      setState(() => _loadingMoreHistory = true);
    } else {
      _historyPage = 1;
      setState(() => _loadingHistory = true);
    }

    try {
      final page = loadMore ? _historyPage + 1 : 1;
      final resp = await ApiClient.get(
        '/gamification/history',
        queryParameters: {'page': '$page', 'limit': '20'},
      );
      if (!mounted) return;
      if (resp.isSuccess) {
        final data = resp.data is Map ? resp.data as Map<String, dynamic> : {};
        final entries =
            (data['entries'] as List? ??
                    data['history'] as List? ??
                    (resp.data is List ? resp.data as List : []))
                .map((e) => Map<String, dynamic>.from(e as Map))
                .toList();

        setState(() {
          if (loadMore) {
            _history.addAll(entries);
          } else {
            _history = entries;
          }
          _historyPage = page;
          _hasMoreHistory = entries.length >= 20;
        });
      }
    } catch (e) {
      debugPrint('fetchHistory error: $e');
    } finally {
      if (mounted) {
        setState(() {
          _loadingHistory = false;
          _loadingMoreHistory = false;
        });
      }
    }
  }

  Future<void> _refreshOverview() async {
    await Future.wait([_fetchSummary(), _fetchHubStats()]);
  }

  Future<void> _claimMilestone(String milestoneId) async {
    setState(() => _claimingIds.add(milestoneId));
    try {
      final resp = await ApiClient.post(
        '/gamification/milestones/$milestoneId/claim',
      );
      if (!mounted) return;
      if (resp.isSuccess) {
        final data = resp.data is Map ? resp.data as Map<String, dynamic> : {};
        final voucherCode =
            data['voucherCode']?.toString() ??
            data['voucher']?.toString() ??
            '';
        final rewardDesc =
            data['rewardDescription']?.toString() ??
            data['description']?.toString() ??
            'Reward claimed!';
        _showVoucherDialog(voucherCode, rewardDesc);
        _fetchMilestones();
        _fetchSummary();
        _fetchHubStats();
      } else {
        _showError(resp.message ?? 'Failed to claim milestone');
      }
    } catch (e) {
      debugPrint('claimMilestone error: $e');
      _showError('Failed to claim milestone');
    } finally {
      if (mounted) setState(() => _claimingIds.remove(milestoneId));
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  void _showVoucherDialog(String voucherCode, String description) {
    final theme = Theme.of(context);
    final l = AppLocalizations.of(context)!;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Row(
          children: [
            Icon(Icons.celebration, color: theme.colorScheme.primary, size: 28),
            const SizedBox(width: 8),
            Text(l.gamificationRewardClaimed),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              description,
              style: theme.textTheme.bodyMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            if (voucherCode.isNotEmpty) ...[
              Text(l.gamificationVoucherCode, style: theme.textTheme.bodySmall),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: theme.colorScheme.primaryContainer,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      voucherCode,
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.bold,
                        letterSpacing: 2,
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      icon: const Icon(Icons.copy, size: 20),
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: voucherCode));
                        ScaffoldMessenger.of(ctx).showSnackBar(
                          SnackBar(
                            content: Text(l.gamificationVoucherCopied),
                            behavior: SnackBarBehavior.floating,
                            duration: const Duration(seconds: 2),
                          ),
                        );
                      },
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  // ─── Build ───────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Health Hub',
      icon: Icons.health_and_safety_outlined,
      color: const Color(0xFF80CBC4),
      heroTag: 'health-points',
      child: Column(
        children: [
          _HealthHubStatsPanel(
            loading: _loadingHubStats,
            summary: _summary,
            stepProfile: _stepProfile,
            stepHistory: _stepHistory,
            wellnessScore: _wellnessScore,
            syncStatus: _syncStatus,
            onRefresh: _refreshOverview,
          ),
          const SizedBox(height: 12),
          TabBar(
            controller: _tabController,
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: const [
              Tab(text: 'Overview'),
              Tab(text: 'Milestones'),
              Tab(text: 'Achievements'),
              Tab(text: 'My Rewards'),
              Tab(text: 'History'),
            ],
          ),
          const SizedBox(height: 8),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                OverviewTab(
                  summary: _summary,
                  loading: _loadingSummary,
                  onRefresh: _refreshOverview,
                ),
                MilestonesTab(
                  milestones: _milestones,
                  loading: _loadingMilestones,
                  claimingIds: _claimingIds,
                  onClaim: _claimMilestone,
                  onRefresh: _fetchMilestones,
                ),
                const AchievementGrid(),
                RewardsTab(
                  rewards: _rewards,
                  loading: _loadingRewards,
                  onRefresh: _fetchRewards,
                ),
                HistoryTab(
                  history: _history,
                  loading: _loadingHistory,
                  hasMore: _hasMoreHistory,
                  loadingMore: _loadingMoreHistory,
                  onRefresh: () => _fetchHistory(),
                  onLoadMore: () => _fetchHistory(loadMore: true),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _HealthHubStatsPanel extends StatelessWidget {
  final bool loading;
  final Map<String, dynamic>? summary;
  final Map<String, dynamic>? stepProfile;
  final Map<String, dynamic>? stepHistory;
  final Map<String, dynamic>? wellnessScore;
  final Map<String, dynamic>? syncStatus;
  final Future<void> Function() onRefresh;

  const _HealthHubStatsPanel({
    required this.loading,
    required this.summary,
    required this.stepProfile,
    required this.stepHistory,
    required this.wellnessScore,
    required this.syncStatus,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final profile = _mapValue(stepProfile?['profile']) ?? const {};
    final totalPoints =
        _asInt(summary?['totalPoints']) ?? _asInt(summary?['total']) ?? 0;
    final wellness = _asInt(wellnessScore?['score']);
    final goal = _asInt(profile['daily_goal']) ?? 8000;
    final today = _todayStepRow(stepHistory);
    final syncedToday = _mapValue(syncStatus?['today']) ?? const {};
    final latestSync = _mapValue(syncStatus?['latest']);
    final syncedSteps = _asInt(syncedToday['steps']) ?? 0;
    final syncedDistance = _asDouble(syncedToday['distanceMeters']) ?? 0;
    final steps = syncedSteps > 0 ? syncedSteps : _asInt(today?['steps']) ?? 0;
    final distanceMeters = syncedDistance > 0
        ? syncedDistance
        : _asDouble(today?['distanceMeters']) ?? 0;
    final sleepMinutes =
        _asInt(syncedToday['sleepMinutes']) ??
        _asInt(latestSync?['sleepMinutes']) ??
        0;
    final syncSource = _sourceLabel(latestSync?['source']?.toString());
    final progress = goal > 0 ? (steps / goal).clamp(0.0, 1.0).toDouble() : 0.0;

    return Container(
      decoration: BoxDecoration(
        color: cs.surface.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: cs.primary.withValues(alpha: 0.18)),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: cs.primary.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.sports_score_outlined,
                  color: cs.primary,
                  size: 22,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Central stats',
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      loading
                          ? 'Refreshing your activity'
                          : syncSource == null
                          ? 'Walking, points, wellness, and sleep readiness'
                          : 'Walking, sleep, and points from $syncSource',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Refresh stats',
                onPressed: loading ? null : onRefresh,
                icon: const Icon(Icons.refresh, size: 20),
              ),
            ],
          ),
          const SizedBox(height: 12),
          LayoutBuilder(
            builder: (context, constraints) {
              final isCompact = constraints.maxWidth < 430;
              final columns = isCompact ? 2 : 3;
              return GridView.count(
                crossAxisCount: columns,
                mainAxisSpacing: 8,
                crossAxisSpacing: 8,
                childAspectRatio: isCompact ? 1.65 : 1.45,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                children: [
                  _HubMetricTile(
                    icon: Icons.directions_walk,
                    tint: Colors.lightBlueAccent,
                    label: 'Walking',
                    value: loading ? '-' : _formatThousands(steps),
                    caption: syncSource == null
                        ? '$goal-step goal'
                        : '$goal-step goal · $syncSource',
                    progress: progress,
                  ),
                  _HubMetricTile(
                    icon: Icons.route_outlined,
                    tint: Colors.tealAccent,
                    label: 'Distance',
                    value: loading ? '-' : _formatKm(distanceMeters),
                    caption: 'today',
                  ),
                  _HubMetricTile(
                    icon: Icons.nightlight_round,
                    tint: Colors.deepPurpleAccent,
                    label: 'Sleep',
                    value: loading
                        ? '-'
                        : sleepMinutes > 0
                        ? _formatSleep(sleepMinutes)
                        : 'No data',
                    caption: syncSource == null
                        ? 'Connect Health data'
                        : '$syncSource sync',
                  ),
                  _HubMetricTile(
                    icon: Icons.monitor_heart_outlined,
                    tint: _wellnessColor(wellness),
                    label: 'Wellness',
                    value: wellness == null ? '-' : '$wellness',
                    caption: 'out of 100',
                    progress: wellness == null
                        ? null
                        : (wellness / 100).clamp(0.0, 1.0).toDouble(),
                  ),
                  _HubMetricTile(
                    icon: Icons.emoji_events_outlined,
                    tint: Colors.amber,
                    label: 'Points',
                    value: '$totalPoints',
                    caption: 'current balance',
                  ),
                  _HubMetricTile(
                    icon: Icons.flag_outlined,
                    tint: Colors.greenAccent,
                    label: 'Goal',
                    value: '${(progress * 100).round()}%',
                    caption: 'steps today',
                    progress: progress,
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }

  static Map<String, dynamic>? _todayStepRow(Map<String, dynamic>? history) {
    final daily = history?['daily'];
    if (daily is! List || daily.isEmpty) return null;
    final todayIso = DateTime.now().toIso8601String().split('T').first;
    for (final row in daily) {
      if (row is Map && row['date']?.toString() == todayIso) {
        return Map<String, dynamic>.from(row);
      }
    }
    final first = daily.first;
    return first is Map ? Map<String, dynamic>.from(first) : null;
  }

  static Map<String, dynamic>? _mapValue(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return null;
  }

  static int? _asInt(dynamic value) {
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  static double? _asDouble(dynamic value) {
    if (value is num) return value.toDouble();
    return double.tryParse(value?.toString() ?? '');
  }

  static String _formatThousands(int n) {
    if (n < 1000) return '$n';
    return '${(n / 1000).toStringAsFixed(n % 1000 == 0 ? 0 : 1)}k';
  }

  static String _formatKm(double meters) {
    final km = meters / 1000;
    return '${km.toStringAsFixed(km >= 10 ? 1 : 2)} km';
  }

  static String _formatSleep(int minutes) {
    final hours = minutes ~/ 60;
    final mins = minutes % 60;
    if (hours <= 0) return '${mins}m';
    if (mins == 0) return '${hours}h';
    return '${hours}h ${mins}m';
  }

  static String? _sourceLabel(String? source) {
    switch (source) {
      case 'health_connect':
        return 'Health Connect';
      case 'healthkit':
        return 'Apple Health';
      case 'strava':
        return 'Strava';
      case 'fitbit':
        return 'Fitbit';
      case 'garmin':
        return 'Garmin';
      case 'oura':
        return 'Oura';
      case 'withings':
        return 'Withings';
      case 'samsung_health':
        return 'Samsung Health';
      case 'polar':
        return 'Polar';
      case 'wearable':
        return 'Wearable';
      default:
        return null;
    }
  }

  static Color _wellnessColor(int? score) {
    if (score == null) return Colors.tealAccent;
    if (score >= 80) return Colors.greenAccent;
    if (score >= 55) return Colors.amberAccent;
    return Colors.redAccent;
  }
}

class _HubMetricTile extends StatelessWidget {
  final IconData icon;
  final Color tint;
  final String label;
  final String value;
  final String caption;
  final double? progress;

  const _HubMetricTile({
    required this.icon,
    required this.tint,
    required this.label,
    required this.value,
    required this.caption,
    this.progress,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: tint.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: tint.withValues(alpha: 0.24)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 15, color: tint),
              const SizedBox(width: 5),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: cs.onSurfaceVariant,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const Spacer(),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              maxLines: 1,
              style: theme.textTheme.titleMedium?.copyWith(
                color: tint,
                fontWeight: FontWeight.w900,
                height: 1,
              ),
            ),
          ),
          const SizedBox(height: 3),
          Text(
            caption,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.labelSmall?.copyWith(
              color: cs.onSurfaceVariant,
            ),
          ),
          if (progress != null) ...[
            const SizedBox(height: 5),
            ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(
                value: progress!.clamp(0.0, 1.0).toDouble(),
                minHeight: 3,
                backgroundColor: tint.withValues(alpha: 0.14),
                valueColor: AlwaysStoppedAnimation(tint),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
