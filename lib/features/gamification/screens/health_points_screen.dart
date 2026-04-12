// lib/features/gamification/screens/health_points_screen.dart
// Health Points — tier progress, milestones, rewards, and point history.

import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/dashboard/widgets/next_visit_progress_widget.dart';
import 'package:vhhealth/features/gamification/widgets/achievement_grid.dart';

// ─── Screen ──────────────────────────────────────────────────────────────────

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
        }).toList();
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
        final entries = (data['entries'] as List? ??
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
        final voucherCode = data['voucherCode']?.toString() ??
            data['voucher']?.toString() ??
            '';
        final rewardDesc = data['rewardDescription']?.toString() ??
            data['description']?.toString() ??
            'Reward claimed!';
        // Show voucher dialog
        _showVoucherDialog(voucherCode, rewardDesc);
        // Refresh milestones and summary
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
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: Theme.of(context).colorScheme.error,
      behavior: SnackBarBehavior.floating,
    ));
  }

  void _showVoucherDialog(String voucherCode, String description) {
    final theme = Theme.of(context);
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Row(
          children: [
            Icon(Icons.celebration,
                color: theme.colorScheme.primary, size: 28),
            const SizedBox(width: 8),
            const Text('Reward Claimed!'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(description,
                style: theme.textTheme.bodyMedium,
                textAlign: TextAlign.center),
            const SizedBox(height: 16),
            if (voucherCode.isNotEmpty) ...[
              Text('Your voucher code:',
                  style: theme.textTheme.bodySmall),
              const SizedBox(height: 8),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
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
                _buildOverviewTab(),
                _buildMilestonesTab(),
                const AchievementGrid(),
                _buildRewardsTab(),
                _buildHistoryTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ─── Tab 1: Overview ─────────────────────────────────────────────────────

  Widget _buildOverviewTab() {
    if (_loadingSummary) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (_summary == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.emoji_events_outlined,
                size: 48,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.3)),
            const SizedBox(height: 12),
            Text('Could not load your points summary',
                style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _fetchSummary,
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final total = (_summary!['totalPoints'] as num?)?.toInt() ??
        (_summary!['total'] as num?)?.toInt() ??
        0;
    final currentTier = _summary!['currentTier']?.toString() ?? 'Bronze';
    final nextTier = _summary!['nextTier']?.toString() ?? '';
    final progress =
        (_summary!['progressToNextTier'] as num?)?.toDouble().clamp(0.0, 1.0) ??
            0.0;
    final pointsToNext = (_summary!['pointsToNextTier'] as num?)?.toInt() ?? 0;
    final tierColor = _getTierColor(currentTier);

    // Activities list from summary
    final activities = _summary!['activities'] as List? ??
        _summary!['earnActivities'] as List? ??
        [];

    // Next appointment detail from summary
    final nextAppt =
        _summary!['nextAppointmentDetail'] as Map<String, dynamic>?;

    return RefreshIndicator(
      onRefresh: _fetchSummary,
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          // Big circular progress
          Center(
            child: SizedBox(
              width: 180,
              height: 180,
              child: CustomPaint(
                painter: _TierRingPainter(
                  progress: progress,
                  tierColor: tierColor,
                  backgroundColor:
                      cs.onSurface.withValues(alpha: 0.1),
                ),
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        total.toString(),
                        style: theme.textTheme.headlineLarge?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: tierColor,
                        ),
                      ),
                      Text(
                        'points',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurface.withValues(alpha: 0.6),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),

          const SizedBox(height: 12),

          // Tier name + icon
          Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(_getTierIcon(currentTier), color: tierColor, size: 22),
                const SizedBox(width: 6),
                Text(
                  currentTier,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: tierColor,
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: 6),

          // Next tier info
          if (nextTier.isNotEmpty)
            Center(
              child: Text(
                'Next: $nextTier ${pointsToNext > 0 ? '-- $pointsToNext more points' : ''}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: cs.onSurface.withValues(alpha: 0.6),
                ),
              ),
            ),

          const SizedBox(height: 20),

          // Next visit progress
          if (nextAppt != null) ...[
            NextVisitProgressWidget(
              detail: nextAppt,
              onTap: () {},
              onSchedule: () {},
            ),
            const SizedBox(height: 16),
          ],

          // How to earn points card
          if (activities.isNotEmpty) ...[
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16)),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(LucideIcons.zap,
                            color: cs.primary, size: 18),
                        const SizedBox(width: 8),
                        Text(
                          'How to earn points',
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    ...activities.map((a) {
                      final activity = a is Map ? a : {};
                      final name =
                          activity['name']?.toString() ?? 'Activity';
                      final points =
                          (activity['points'] as num?)?.toInt() ?? 0;
                      final icon = _activityIcon(
                          activity['type']?.toString() ?? '');
                      return Padding(
                        padding:
                            const EdgeInsets.symmetric(vertical: 4),
                        child: Row(
                          children: [
                            Icon(icon, size: 16,
                                color: cs.onSurface.withValues(alpha: 0.6)),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(name,
                                  style: theme.textTheme.bodySmall),
                            ),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFFD54F)
                                    .withValues(alpha: 0.2),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text(
                                '+$points',
                                style:
                                    theme.textTheme.labelSmall?.copyWith(
                                  fontWeight: FontWeight.bold,
                                  color: const Color(0xFFFF8F00),
                                ),
                              ),
                            ),
                          ],
                        ),
                      );
                    }),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  // ─── Tab 2: Milestones ───────────────────────────────────────────────────

  Widget _buildMilestonesTab() {
    if (_loadingMilestones && _milestones.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (_milestones.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.emoji_events_outlined,
                size: 48,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.3)),
            const SizedBox(height: 12),
            Text('No milestones available yet',
                style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _fetchMilestones,
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return RefreshIndicator(
      onRefresh: _fetchMilestones,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: _milestones.length,
        itemBuilder: (context, index) {
          final m = _milestones[index];
          final id = m['id']?.toString() ?? m['_id']?.toString() ?? '';
          final name = m['name']?.toString() ?? 'Milestone';
          final tierName = m['tier']?.toString() ?? name;
          final pointsRequired =
              (m['pointsRequired'] as num?)?.toInt() ?? 0;
          final rewardDesc =
              m['rewardDescription']?.toString() ?? m['reward']?.toString() ?? '';
          final status = m['status']?.toString().toUpperCase() ?? 'LOCKED';
          final voucherCode = m['voucherCode']?.toString() ?? '';

          final isLocked = status == 'LOCKED';
          final isClaimable = status == 'CLAIMABLE';
          final isClaimed = status == 'CLAIMED';
          final isClaiming = _claimingIds.contains(id);
          final tierColor = _getTierColor(tierName);

          return Card(
            elevation: 0,
            margin: const EdgeInsets.only(bottom: 10),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: isClaimable
                  ? BorderSide(color: tierColor, width: 2)
                  : BorderSide.none,
            ),
            child: Opacity(
              opacity: isLocked ? 0.5 : 1.0,
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  children: [
                    // Tier icon
                    Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        color: isLocked
                            ? cs.onSurface.withValues(alpha: 0.08)
                            : tierColor.withValues(alpha: 0.15),
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        isClaimed
                            ? Icons.check_circle
                            : _getTierIcon(tierName),
                        color: isLocked
                            ? cs.onSurface.withValues(alpha: 0.3)
                            : tierColor,
                        size: 24,
                      ),
                    ),
                    const SizedBox(width: 12),

                    // Info
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            tierName,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              fontWeight: FontWeight.bold,
                              color: isLocked
                                  ? cs.onSurface.withValues(alpha: 0.5)
                                  : cs.onSurface,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '$pointsRequired points required',
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurface.withValues(alpha: 0.5),
                              fontSize: 11,
                            ),
                          ),
                          if (rewardDesc.isNotEmpty) ...[
                            const SizedBox(height: 2),
                            Text(
                              rewardDesc,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: cs.onSurface.withValues(alpha: 0.7),
                                fontSize: 11,
                              ),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                          if (isClaimed && voucherCode.isNotEmpty) ...[
                            const SizedBox(height: 4),
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.confirmation_num,
                                    size: 14,
                                    color: cs.primary),
                                const SizedBox(width: 4),
                                Text(
                                  voucherCode,
                                  style:
                                      theme.textTheme.bodySmall?.copyWith(
                                    fontWeight: FontWeight.bold,
                                    color: cs.primary,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),

                    // Action
                    if (isClaimable)
                      SizedBox(
                        height: 32,
                        child: FilledButton(
                          onPressed:
                              isClaiming ? null : () => _claimMilestone(id),
                          style: FilledButton.styleFrom(
                            backgroundColor: tierColor,
                            padding: const EdgeInsets.symmetric(
                                horizontal: 14),
                          ),
                          child: isClaiming
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Text('Claim'),
                        ),
                      ),
                    if (isClaimed)
                      Icon(Icons.check_circle,
                          color: ThemeData().colorScheme.primary, size: 24),
                    if (isLocked)
                      Icon(Icons.lock,
                          color: cs.onSurface.withValues(alpha: 0.3),
                          size: 20),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  // ─── Tab 3: My Rewards ───────────────────────────────────────────────────

  Widget _buildRewardsTab() {
    if (_loadingRewards && _rewards.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (_rewards.isEmpty) {
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
              onPressed: _fetchRewards,
              child: const Text('Refresh'),
            ),
          ],
        ),
      );
    }

    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return RefreshIndicator(
      onRefresh: _fetchRewards,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: _rewards.length,
        itemBuilder: (context, index) {
          final r = _rewards[index];
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

          // Skip redeemed or expired vouchers
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

  // ─── Tab 4: History ──────────────────────────────────────────────────────

  Widget _buildHistoryTab() {
    if (_loadingHistory && _history.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (_history.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.history,
                size: 48,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.3)),
            const SizedBox(height: 12),
            Text('No point history yet',
                style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => _fetchHistory(),
              child: const Text('Refresh'),
            ),
          ],
        ),
      );
    }

    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return RefreshIndicator(
      onRefresh: () => _fetchHistory(),
      child: NotificationListener<ScrollNotification>(
        onNotification: (scrollInfo) {
          if (scrollInfo.metrics.pixels >=
                  scrollInfo.metrics.maxScrollExtent - 100 &&
              _hasMoreHistory &&
              !_loadingMoreHistory) {
            _fetchHistory(loadMore: true);
          }
          return false;
        },
        child: ListView.builder(
          padding: const EdgeInsets.symmetric(vertical: 8),
          itemCount: _history.length + (_hasMoreHistory ? 1 : 0),
          itemBuilder: (context, index) {
            if (index >= _history.length) {
              return const Center(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              );
            }

            final entry = _history[index];
            final description =
                entry['description']?.toString() ?? 'Points activity';
            final points = (entry['points'] as num?)?.toInt() ?? 0;
            final dateStr = entry['createdAt']?.toString() ??
                entry['date']?.toString() ??
                '';
            final activityType = entry['activityType']?.toString() ??
                entry['type']?.toString() ??
                '';

            final isPositive = points >= 0;
            final pointColor = isPositive
                ? ThemeData().brightness == Brightness.dark
                    ? Colors.green.shade400
                    : Colors.green.shade600
                : cs.error;

            String formattedDate = '';
            if (dateStr.isNotEmpty) {
              try {
                final parsed = DateTime.tryParse(dateStr);
                if (parsed != null) {
                  formattedDate =
                      DateFormat('dd MMM yyyy, HH:mm').format(parsed);
                }
              } catch (_) {
                formattedDate = dateStr;
              }
            }

            return Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  // Activity icon
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: (isPositive
                              ? Colors.green
                              : cs.error)
                          .withValues(alpha: 0.1),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      _activityIcon(activityType),
                      size: 16,
                      color: isPositive ? Colors.green : cs.error,
                    ),
                  ),
                  const SizedBox(width: 10),

                  // Description + date
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
                              color:
                                  cs.onSurface.withValues(alpha: 0.5),
                              fontSize: 10,
                            ),
                          ),
                      ],
                    ),
                  ),

                  // Points
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 3),
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

  // ─── Shared helpers ──────────────────────────────────────────────────────

  Color _getTierColor(String tier) {
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

  IconData _getTierIcon(String tier) {
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

  IconData _activityIcon(String type) {
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
}

// ─── Custom Painter for Tier Ring ────────────────────────────────────────────

class _TierRingPainter extends CustomPainter {
  final double progress;
  final Color tierColor;
  final Color backgroundColor;

  _TierRingPainter({
    required this.progress,
    required this.tierColor,
    required this.backgroundColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = math.min(size.width, size.height) / 2 - 12;
    const strokeWidth = 10.0;

    // Background ring
    final bgPaint = Paint()
      ..color = backgroundColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;

    canvas.drawCircle(center, radius, bgPaint);

    // Progress arc
    final fgPaint = Paint()
      ..color = tierColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round;

    final sweepAngle = 2 * math.pi * progress;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2, // start from top
      sweepAngle,
      false,
      fgPaint,
    );
  }

  @override
  bool shouldRepaint(covariant _TierRingPainter oldDelegate) {
    return oldDelegate.progress != progress ||
        oldDelegate.tierColor != tierColor;
  }
}
