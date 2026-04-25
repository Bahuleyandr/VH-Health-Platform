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

  // ── Milestones data ──
  bool _loadingMilestones = true;
  List<Map<String, dynamic>> _milestones = [];
  final Set<String> _claimingIds = {};

  // ── Rewards (My Rewards) ──
  bool _loadingRewards = true;
  List<Map<String, dynamic>> _rewards = [];

  // ── History data ──
  bool _loadingHistory = true;
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
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Row(
          children: [
            Icon(Icons.celebration, color: theme.colorScheme.primary, size: 28),
            const SizedBox(width: 8),
            const Text('Reward Claimed!'),
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
              Text('Your voucher code:', style: theme.textTheme.bodySmall),
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
                          const SnackBar(
                            content: Text('Voucher code copied!'),
                            behavior: SnackBarBehavior.floating,
                            duration: Duration(seconds: 2),
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
      title: 'Health Points',
      icon: Icons.emoji_events,
      color: const Color(0xFFFFD54F),
      heroTag: 'health-points',
      child: Column(
        children: [
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
          SizedBox(
            height: MediaQuery.of(context).size.height * 0.65,
            child: TabBarView(
              controller: _tabController,
              children: [
                OverviewTab(
                  summary: _summary,
                  loading: _loadingSummary,
                  onRefresh: _fetchSummary,
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
