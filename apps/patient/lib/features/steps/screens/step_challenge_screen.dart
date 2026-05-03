// lib/features/steps/screens/step_challenge_screen.dart
// Step Challenge — GPS walk tracking, leaderboard, tiered history, rewards

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:geolocator/geolocator.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:pedometer/pedometer.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

// ─── Data models ─────────────────────────────────────────────────────────────

class _StepProfile {
  final String displayName;
  final String displayColor;
  final int dailyGoal;
  final bool optedIn;

  const _StepProfile({
    required this.displayName,
    required this.displayColor,
    required this.dailyGoal,
    required this.optedIn,
  });

  factory _StepProfile.fromJson(Map<String, dynamic> j) => _StepProfile(
    displayName: j['display_name']?.toString() ?? '',
    displayColor: j['display_color']?.toString() ?? '#2196F3',
    dailyGoal: (j['daily_goal'] as num?)?.toInt() ?? 8000,
    optedIn: j['opted_in'] as bool? ?? true,
  );
}

class _DailyRow {
  final String date;
  final int steps;
  final double distanceMeters;
  const _DailyRow({
    required this.date,
    required this.steps,
    required this.distanceMeters,
  });

  factory _DailyRow.fromJson(Map<String, dynamic> j) => _DailyRow(
    date: j['date']?.toString() ?? '',
    steps: (j['steps'] as num?)?.toInt() ?? 0,
    distanceMeters: (j['distanceMeters'] as num?)?.toDouble() ?? 0,
  );
}

class _WeeklyRow {
  final String weekStart;
  final int avgSteps;
  final double avgDistanceMeters;
  const _WeeklyRow({
    required this.weekStart,
    required this.avgSteps,
    required this.avgDistanceMeters,
  });

  factory _WeeklyRow.fromJson(Map<String, dynamic> j) => _WeeklyRow(
    weekStart: j['weekStart']?.toString() ?? '',
    avgSteps: (j['avgSteps'] as num?)?.toInt() ?? 0,
    avgDistanceMeters: (j['avgDistanceMeters'] as num?)?.toDouble() ?? 0,
  );
}

class _MonthlyRow {
  final String month;
  final int avgSteps;
  final double avgDistanceMeters;
  const _MonthlyRow({
    required this.month,
    required this.avgSteps,
    required this.avgDistanceMeters,
  });

  factory _MonthlyRow.fromJson(Map<String, dynamic> j) => _MonthlyRow(
    month: j['month']?.toString() ?? '',
    avgSteps: (j['avgSteps'] as num?)?.toInt() ?? 0,
    avgDistanceMeters: (j['avgDistanceMeters'] as num?)?.toDouble() ?? 0,
  );
}

class _LeaderEntry {
  final String displayName;
  final String displayColor;
  final int totalSteps;
  final double totalDistanceMeters;
  final int rank;
  final bool isMe;

  const _LeaderEntry({
    required this.displayName,
    required this.displayColor,
    required this.totalSteps,
    required this.totalDistanceMeters,
    required this.rank,
    required this.isMe,
  });

  factory _LeaderEntry.fromJson(Map<String, dynamic> j) => _LeaderEntry(
    displayName: j['displayName']?.toString() ?? 'Anonymous',
    displayColor: j['displayColor']?.toString() ?? '#2196F3',
    totalSteps: (j['totalSteps'] as num?)?.toInt() ?? 0,
    totalDistanceMeters: (j['totalDistanceMeters'] as num?)?.toDouble() ?? 0,
    rank: (j['rank'] as num?)?.toInt() ?? 0,
    isMe: j['isMe'] as bool? ?? false,
  );
}

class _Reward {
  final String rewardType;
  final String description;
  final bool isApplied;

  const _Reward({
    required this.rewardType,
    required this.description,
    required this.isApplied,
  });

  factory _Reward.fromJson(Map<String, dynamic> j) => _Reward(
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

// ─── Screen ──────────────────────────────────────────────────────────────────

class StepChallengeScreen extends StatefulWidget {
  const StepChallengeScreen({super.key});

  @override
  State<StepChallengeScreen> createState() => _StepChallengeScreenState();
}

class _StepChallengeScreenState extends State<StepChallengeScreen>
    with SingleTickerProviderStateMixin {
  // ── Tab controller ──
  late final TabController _historyTabController;

  // ── Profile ──
  _StepProfile? _profile;
  bool _loadingProfile = true;
  bool _savingProfile = false;
  final _nameController = TextEditingController();
  String _editColor = '#2196F3';
  final List<String> _colorOptions = [
    '#2196F3',
    '#4CAF50',
    '#FF5722',
    '#9C27B0',
    '#00BCD4',
    '#FF9800',
    '#E91E63',
    '#795548',
  ];

  // ── History ──
  List<_DailyRow> _daily = [];
  List<_WeeklyRow> _weekly = [];
  List<_MonthlyRow> _monthly = [];
  bool _loadingHistory = true;

  // ── Leaderboard ──
  List<_LeaderEntry> _leaderboard = [];
  Map<String, dynamic>? _myRank;
  bool _loadingLeaderboard = true;

  // ── Rewards ──
  List<_Reward> _rewards = [];
  bool _loadingRewards = true;

  // ── Walk session (GPS) ──
  bool _isWalking = false;
  int? _activeSessionId;
  double _totalDistanceMeters = 0;
  int _estimatedSteps = 0;
  int _elapsedSeconds = 0;
  Position? _lastPosition;
  StreamSubscription<Position>? _positionStream;
  Timer? _elapsedTimer;

  // ── Pedometer (hardware step counter) ──
  StreamSubscription<StepCount>? _pedometerSubscription;
  int? _pedometerBaseline;

  @override
  void initState() {
    super.initState();
    _historyTabController = TabController(length: 3, vsync: this);
    _initPedometer();
    _fetchAll();
  }

  void _initPedometer() {
    try {
      _pedometerSubscription = Pedometer.stepCountStream.listen(
        (StepCount event) {
          if (!mounted || !_isWalking) return;
          if (_pedometerBaseline == null) {
            // Record the baseline step count when the walk session starts
            _pedometerBaseline = event.steps;
            return;
          }
          final stepsSinceStart = event.steps - _pedometerBaseline!;
          if (stepsSinceStart > 0) {
            setState(() {
              _estimatedSteps = stepsSinceStart;
            });
          }
        },
        onError: (e) {
          debugPrint('Pedometer stream error: $e');
        },
      );
    } catch (e) {
      debugPrint('Pedometer initialization failed: $e');
    }
  }

  @override
  void dispose() {
    _historyTabController.dispose();
    _nameController.dispose();
    _positionStream?.cancel();
    _elapsedTimer?.cancel();
    _pedometerSubscription?.cancel();
    super.dispose();
  }

  // ─── Data fetching ───────────────────────────────────────────────────────

  Future<void> _fetchAll() async {
    await Future.wait([
      _fetchProfile(),
      _fetchHistory(),
      _fetchLeaderboard(),
      _fetchRewards(),
    ]);
  }

  Future<void> _fetchProfile() async {
    setState(() => _loadingProfile = true);
    try {
      final resp = await ApiClient.get('/steps/profile');
      if (resp.isSuccess && resp.data is Map) {
        final profileData = resp.data['profile'] ?? resp.data;
        if (profileData is Map<String, dynamic>) {
          final p = _StepProfile.fromJson(profileData);
          setState(() {
            _profile = p;
            _nameController.text = p.displayName;
            _editColor = p.displayColor;
          });
        }
      }
    } catch (e) {
      debugPrint('fetchProfile error: $e');
    } finally {
      if (mounted) setState(() => _loadingProfile = false);
    }
  }

  Future<void> _fetchHistory() async {
    setState(() => _loadingHistory = true);
    try {
      final resp = await ApiClient.get('/steps/history');
      if (resp.isSuccess && resp.data is Map) {
        final d = resp.data as Map<String, dynamic>;
        setState(() {
          _daily = (d['daily'] as List? ?? [])
              .cast<Map<String, dynamic>>()
              .map(_DailyRow.fromJson)
              .toList();
          _weekly = (d['weekly'] as List? ?? [])
              .cast<Map<String, dynamic>>()
              .map(_WeeklyRow.fromJson)
              .toList();
          _monthly = (d['monthly'] as List? ?? [])
              .cast<Map<String, dynamic>>()
              .map(_MonthlyRow.fromJson)
              .toList();
        });
      }
    } catch (e) {
      debugPrint('fetchHistory error: $e');
    } finally {
      if (mounted) setState(() => _loadingHistory = false);
    }
  }

  Future<void> _fetchLeaderboard() async {
    setState(() => _loadingLeaderboard = true);
    try {
      final resp = await ApiClient.get('/steps/leaderboard');
      if (resp.isSuccess && resp.data is Map) {
        final d = resp.data as Map<String, dynamic>;
        setState(() {
          _leaderboard = (d['leaderboard'] as List? ?? [])
              .cast<Map<String, dynamic>>()
              .map(_LeaderEntry.fromJson)
              .toList();
          _myRank = d['myRank'] as Map<String, dynamic>?;
        });
      }
    } catch (e) {
      debugPrint('fetchLeaderboard error: $e');
    } finally {
      if (mounted) setState(() => _loadingLeaderboard = false);
    }
  }

  Future<void> _fetchRewards() async {
    setState(() => _loadingRewards = true);
    try {
      final resp = await ApiClient.get('/steps/rewards');
      if (resp.isSuccess && resp.data is Map) {
        final list = resp.data['rewards'] as List? ?? [];
        setState(() {
          _rewards = list
              .cast<Map<String, dynamic>>()
              .map(_Reward.fromJson)
              .toList();
        });
      }
    } catch (e) {
      debugPrint('fetchRewards error: $e');
    } finally {
      if (mounted) setState(() => _loadingRewards = false);
    }
  }

  // ─── Profile save ────────────────────────────────────────────────────────

  Future<void> _saveProfile() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      _showError('Display name cannot be empty');
      return;
    }
    setState(() => _savingProfile = true);
    try {
      final resp = await ApiClient.put(
        '/steps/profile',
        body: {
          'displayName': name,
          'displayColor': _editColor,
          'dailyGoal': _profile?.dailyGoal ?? 8000,
          'optedIn': _profile?.optedIn ?? true,
        },
      );
      if (resp.isSuccess) {
        await _fetchProfile();
        _showSuccess('Profile saved');
      } else {
        _showError(resp.message ?? 'Failed to save profile');
      }
    } catch (e) {
      _showError('Failed to save profile');
    } finally {
      if (mounted) setState(() => _savingProfile = false);
    }
  }

  // ─── GPS walk ────────────────────────────────────────────────────────────

  Future<void> _startWalk() async {
    // Request location permission
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      _showError('Location permission required to track walk');
      return;
    }

    // Start session on backend
    try {
      final resp = await ApiClient.post('/steps/session/start');
      if (!resp.isSuccess) {
        _showError(resp.message ?? 'Failed to start session');
        return;
      }
      final sessionId = (resp.data['sessionId'] as num?)?.toInt();
      if (sessionId == null) {
        _showError('Invalid session response');
        return;
      }

      setState(() {
        _isWalking = true;
        _activeSessionId = sessionId;
        _totalDistanceMeters = 0;
        _estimatedSteps = 0;
        _elapsedSeconds = 0;
        _lastPosition = null;
        _pedometerBaseline =
            null; // Reset so next pedometer event sets baseline
      });

      // Start GPS stream
      _positionStream =
          Geolocator.getPositionStream(
            locationSettings: const LocationSettings(
              accuracy: LocationAccuracy.high,
              distanceFilter: 5,
            ),
          ).listen(
            (Position pos) {
              if (!mounted) return;
              if (_lastPosition != null) {
                final dist = Geolocator.distanceBetween(
                  _lastPosition!.latitude,
                  _lastPosition!.longitude,
                  pos.latitude,
                  pos.longitude,
                );
                setState(() {
                  _totalDistanceMeters += dist;
                  _estimatedSteps = (_totalDistanceMeters / 0.762).round();
                });
              }
              _lastPosition = pos;
            },
            onError: (e) {
              debugPrint('GPS stream error: $e');
            },
          );

      // Elapsed timer
      _elapsedTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() => _elapsedSeconds++);
      });
    } catch (e) {
      _showError('Failed to start walk');
    }
  }

  Future<void> _stopWalk() async {
    _positionStream?.cancel();
    _positionStream = null;
    _elapsedTimer?.cancel();
    _elapsedTimer = null;

    final sessionId = _activeSessionId;
    final steps = _estimatedSteps;
    final distance = _totalDistanceMeters;
    final duration = _elapsedSeconds;

    setState(() {
      _isWalking = false;
      _activeSessionId = null;
      _totalDistanceMeters = 0;
      _estimatedSteps = 0;
      _elapsedSeconds = 0;
      _lastPosition = null;
      _pedometerBaseline = null;
    });

    if (sessionId == null) return;

    try {
      final resp = await ApiClient.post(
        '/steps/session/stop',
        body: {
          'sessionId': sessionId,
          'steps': steps,
          'distanceMeters': distance,
          'durationSeconds': duration,
        },
      );

      if (resp.isSuccess) {
        final distKm = (distance / 1000).toStringAsFixed(2);
        _showSuccess('Walk done! $steps steps • ${distKm}km');
        await Future.wait([_fetchHistory(), _fetchLeaderboard()]);
      } else {
        _showError(resp.message ?? 'Failed to save walk data');
      }
    } catch (e) {
      _showError('Failed to save walk data');
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

  void _showSuccess(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: Colors.green[700],
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  Color _hexColor(String hex) {
    try {
      return Color(int.parse(hex.replaceFirst('#', '0xFF')));
    } catch (_) {
      return const Color(0xFF2196F3);
    }
  }

  String _formatElapsed(int seconds) {
    final m = (seconds ~/ 60).toString().padLeft(2, '0');
    final s = (seconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  String _distKm(double m) => '${(m / 1000).toStringAsFixed(2)} km';

  // ─── Today's stats helper ─────────────────────────────────────────────────
  _DailyRow? get _todayRow {
    final today = DateTime.now();
    final todayStr =
        '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
    try {
      return _daily.firstWhere((r) => r.date == todayStr);
    } catch (_) {
      return null;
    }
  }

  // ─── Build ───────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Step Challenge 🏃',
      icon: LucideIcons.footprints,
      color: const Color(0xFFA5D6A7),
      heroTag: 'steps',
      child: RefreshIndicator(
        onRefresh: _fetchAll,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildProfileSection(),
            const SizedBox(height: 16),
            _buildTodayCard(),
            const SizedBox(height: 16),
            _buildWalkControl(),
            const SizedBox(height: 16),
            _buildHistorySection(),
            const SizedBox(height: 16),
            _buildLeaderboardSection(),
            const SizedBox(height: 16),
            _buildRewardsSection(),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  // ─── Profile section ──────────────────────────────────────────────────────

  Widget _buildProfileSection() {
    if (_loadingProfile) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(8),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    final needsSetup =
        _profile == null ||
        _profile!.displayName.isEmpty ||
        _profile!.displayName.startsWith('User');

    if (!needsSetup) {
      return Card(
        child: ListTile(
          leading: CircleAvatar(
            backgroundColor: _hexColor(_profile!.displayColor),
            child: Text(
              _profile!.displayName.isNotEmpty
                  ? _profile!.displayName[0].toUpperCase()
                  : '?',
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          title: Text(
            _profile!.displayName,
            style: const TextStyle(fontWeight: FontWeight.bold),
          ),
          subtitle: Text('Daily goal: ${_profile!.dailyGoal.toString()} steps'),
          trailing: TextButton(
            onPressed: () => setState(() {
              _nameController.text = _profile?.displayName ?? '';
              _editColor = _profile?.displayColor ?? '#2196F3';
            }),
            child: const Text('Edit'),
          ),
        ),
      );
    }

    // Setup form
    final l = AppLocalizations.of(context)!;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              l.stepsSetupProfileTitle,
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(
                labelText: 'Display name',
                hintText: 'How others see you on the leaderboard',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Text(
              l.stepsPickColor,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: _colorOptions.map((hex) {
                final selected = _editColor == hex;
                return GestureDetector(
                  onTap: () => setState(() => _editColor = hex),
                  child: Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: _hexColor(hex),
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected ? Colors.black : Colors.transparent,
                        width: 2,
                      ),
                    ),
                    child: selected
                        ? const Icon(Icons.check, color: Colors.white, size: 18)
                        : null,
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _savingProfile ? null : _saveProfile,
                child: _savingProfile
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(l.stepsSaveProfile),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ─── Today's stats card ───────────────────────────────────────────────────

  Widget _buildTodayCard() {
    final theme = Theme.of(context);
    final today = _todayRow;
    final steps = today?.steps ?? 0;
    final dist = today?.distanceMeters ?? 0.0;
    final goal = _profile?.dailyGoal ?? 8000;
    final pct = (steps / goal).clamp(0.0, 1.0);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              "Today's Activity",
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                Column(
                  children: [
                    Text(
                      '$steps',
                      style: const TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF4CAF50),
                      ),
                    ),
                    Text(
                      'steps',
                      style: TextStyle(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
                Column(
                  children: [
                    Text(
                      _distKm(dist),
                      style: const TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF2196F3),
                      ),
                    ),
                    Text(
                      'distance',
                      style: TextStyle(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 12),
            LinearProgressIndicator(
              value: pct,
              backgroundColor: theme.colorScheme.outlineVariant,
              color: pct >= 1.0 ? Colors.green : const Color(0xFF4CAF50),
              minHeight: 8,
              borderRadius: BorderRadius.circular(4),
            ),
            const SizedBox(height: 4),
            Text(
              pct >= 1.0
                  ? '🎉 Daily goal reached!'
                  : '${(pct * 100).toStringAsFixed(0)}% of $goal-step goal',
              style: TextStyle(
                fontSize: 12,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ─── Walk control ─────────────────────────────────────────────────────────

  Widget _buildWalkControl() {
    final l = AppLocalizations.of(context)!;
    if (!_isWalking) {
      return SizedBox(
        width: double.infinity,
        height: 64,
        child: ElevatedButton.icon(
          icon: const Icon(Icons.directions_walk, size: 28),
          label: Text(
            l.stepsStartWalkUpper,
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
          ),
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.green[600],
            foregroundColor: Colors.white,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
          onPressed: _startWalk,
        ),
      );
    }

    // Active walk
    return Card(
      color: Colors.green[50],
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text(
              l.stepsWalkInProgress,
              style: const TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 16,
                color: Colors.green,
              ),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                _statChip(Icons.directions_walk, '$_estimatedSteps', 'steps'),
                _statChip(
                  Icons.straighten,
                  _distKm(_totalDistanceMeters),
                  'distance',
                ),
                _statChip(
                  Icons.timer,
                  _formatElapsed(_elapsedSeconds),
                  'elapsed',
                ),
              ],
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton.icon(
                icon: const Icon(Icons.stop_circle_outlined, size: 24),
                label: Text(
                  l.stepsStopWalkUpper,
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red[600],
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                onPressed: _stopWalk,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statChip(IconData icon, String value, String label) {
    return Column(
      children: [
        Icon(icon, color: Colors.green[700], size: 22),
        const SizedBox(height: 4),
        Text(
          value,
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
        ),
        Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
      ],
    );
  }

  // ─── History section ──────────────────────────────────────────────────────

  Widget _buildHistorySection() {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'History',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
        ),
        const SizedBox(height: 8),
        TabBar(
          controller: _historyTabController,
          labelColor: const Color(0xFF4CAF50),
          unselectedLabelColor: theme.colorScheme.onSurfaceVariant,
          indicatorColor: const Color(0xFF4CAF50),
          tabs: const [
            Tab(text: 'Daily'),
            Tab(text: 'Weekly'),
            Tab(text: 'Monthly'),
          ],
        ),
        SizedBox(
          height: 280,
          child: _loadingHistory
              ? const Center(child: CircularProgressIndicator())
              : TabBarView(
                  controller: _historyTabController,
                  children: [
                    _buildDailyList(),
                    _buildWeeklyList(),
                    _buildMonthlyList(),
                  ],
                ),
        ),
      ],
    );
  }

  Widget _buildDailyList() {
    if (_daily.isEmpty) {
      return Center(
        child: Text(
          AppLocalizations.of(context)!.stepsNoDailyData,
          style: const TextStyle(color: Colors.grey),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: _daily.length,
      itemBuilder: (ctx, i) {
        final row = _daily[i];
        return _historyTile(
          title: row.date,
          steps: row.steps,
          distanceMeters: row.distanceMeters,
          subtitle: null,
        );
      },
    );
  }

  Widget _buildWeeklyList() {
    if (_weekly.isEmpty) {
      return Center(
        child: Text(
          AppLocalizations.of(context)!.stepsNoWeeklyData,
          style: const TextStyle(color: Colors.grey),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: _weekly.length,
      itemBuilder: (ctx, i) {
        final row = _weekly[i];
        return _historyTile(
          title: 'Week of ${row.weekStart}',
          steps: row.avgSteps,
          distanceMeters: row.avgDistanceMeters,
          subtitle: 'avg/day',
        );
      },
    );
  }

  Widget _buildMonthlyList() {
    if (_monthly.isEmpty) {
      return Center(
        child: Text(
          AppLocalizations.of(context)!.stepsNoMonthlyData,
          style: const TextStyle(color: Colors.grey),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: _monthly.length,
      itemBuilder: (ctx, i) {
        final row = _monthly[i];
        return _historyTile(
          title: row.month,
          steps: row.avgSteps,
          distanceMeters: row.avgDistanceMeters,
          subtitle: 'avg/day',
        );
      },
    );
  }

  Widget _historyTile({
    required String title,
    required int steps,
    required double distanceMeters,
    required String? subtitle,
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                  ),
                ),
                if (subtitle != null)
                  Text(
                    subtitle,
                    style: const TextStyle(fontSize: 11, color: Colors.grey),
                  ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '$steps steps',
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF4CAF50),
                ),
              ),
              Text(
                _distKm(distanceMeters),
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ─── Leaderboard section ──────────────────────────────────────────────────

  Widget _buildLeaderboardSection() {
    final l = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              l.stepsLeaderboard,
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const Spacer(),
            Text(
              l.stepsThisMonth,
              style: const TextStyle(fontSize: 12, color: Colors.grey),
            ),
          ],
        ),
        const SizedBox(height: 4),
        if (_myRank != null)
          Container(
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: const Color(0xFFE8F5E9),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFF4CAF50)),
            ),
            child: Row(
              children: [
                const Icon(Icons.person, color: Color(0xFF4CAF50), size: 18),
                const SizedBox(width: 8),
                Text(
                  'Your rank: #${_myRank!['rank']} — ${_myRank!['totalSteps']} steps',
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF2E7D32),
                  ),
                ),
              ],
            ),
          ),
        _loadingLeaderboard
            ? const Center(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: CircularProgressIndicator(),
                ),
              )
            : _leaderboard.isEmpty
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    l.stepsNoLeaderboardData,
                    style: const TextStyle(color: Colors.grey),
                  ),
                ),
              )
            : ListView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: _leaderboard.length,
                itemBuilder: (ctx, i) => _leaderboardTile(_leaderboard[i]),
              ),
      ],
    );
  }

  Widget _leaderboardTile(_LeaderEntry entry) {
    final rankLabel = entry.rank == 1
        ? '🥇'
        : entry.rank == 2
        ? '🥈'
        : entry.rank == 3
        ? '🥉'
        : '#${entry.rank}';

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: entry.isMe
            ? const Color(0xFFE8F5E9)
            : Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: entry.isMe
              ? const Color(0xFF4CAF50)
              : Theme.of(context).colorScheme.outlineVariant,
          width: entry.isMe ? 2 : 1,
        ),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 32,
            child: Text(
              rankLabel,
              style: const TextStyle(fontSize: 16),
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(width: 8),
          CircleAvatar(
            radius: 16,
            backgroundColor: _hexColor(entry.displayColor),
            child: Text(
              entry.displayName.isNotEmpty
                  ? entry.displayName[0].toUpperCase()
                  : '?',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 12,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              entry.isMe ? '${entry.displayName} (You)' : entry.displayName,
              style: TextStyle(
                fontWeight: entry.isMe ? FontWeight.bold : FontWeight.normal,
              ),
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '${entry.totalSteps}',
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF4CAF50),
                ),
              ),
              Text(
                _distKm(entry.totalDistanceMeters),
                style: const TextStyle(fontSize: 11, color: Colors.grey),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ─── Rewards section ──────────────────────────────────────────────────────

  Widget _buildRewardsSection() {
    if (_loadingRewards) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(8),
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    if (_rewards.isEmpty) return const SizedBox.shrink();

    final l = AppLocalizations.of(context)!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${l.stepsYourRewards} 🏆',
          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
        ),
        const SizedBox(height: 8),
        ...(_rewards.map(
          (r) => Card(
            color: r.isApplied
                ? Theme.of(context).colorScheme.surfaceContainerLow
                : const Color(0xFFFFF9C4),
            child: ListTile(
              leading: const Icon(Icons.emoji_events, color: Colors.amber),
              title: Text(
                r.displayText,
                style: TextStyle(
                  fontSize: 14,
                  color: r.isApplied
                      ? Theme.of(context).colorScheme.onSurfaceVariant
                      : Theme.of(context).colorScheme.onSurface,
                  decoration: r.isApplied ? TextDecoration.lineThrough : null,
                ),
              ),
              trailing: r.isApplied
                  ? const Icon(Icons.check_circle, color: Colors.grey, size: 20)
                  : const Icon(Icons.star, color: Colors.amber, size: 20),
            ),
          ),
        )),
      ],
    );
  }
}
