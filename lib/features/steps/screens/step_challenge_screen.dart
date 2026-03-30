// lib/features/steps/screens/step_challenge_screen.dart
import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:pedometer/pedometer.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';

// ─────────────────────────────────────────────────────────────────────────────
// Data models
// ─────────────────────────────────────────────────────────────────────────────

class _StepProfile {
  final String leaderboardName;
  final String? avatarColor;
  final bool optOut;

  _StepProfile({
    required this.leaderboardName,
    this.avatarColor,
    required this.optOut,
  });

  factory _StepProfile.fromJson(Map<String, dynamic> j) => _StepProfile(
        leaderboardName: j['leaderboard_name'] ?? 'Walker',
        avatarColor: j['avatar_color'],
        optOut: j['opt_out_leaderboard'] ?? false,
      );
}

class _DaySteps {
  final DateTime date;
  final int steps;

  _DaySteps(this.date, this.steps);
}

class _TieredHistory {
  final List<_DaySteps> daily;
  final List<_DaySteps> weekly;
  final List<_DaySteps> monthly;

  _TieredHistory({required this.daily, required this.weekly, required this.monthly});
}

class _StepSession {
  final int id;
  final DateTime startedAt;
  final DateTime? endedAt;
  final int steps;
  final double distanceKm;
  final int durationSec;

  _StepSession({
    required this.id,
    required this.startedAt,
    this.endedAt,
    required this.steps,
    required this.distanceKm,
    required this.durationSec,
  });

  factory _StepSession.fromJson(Map<String, dynamic> j) => _StepSession(
    id: j['id'] as int,
    startedAt: DateTime.parse(j['started_at'] as String),
    endedAt: j['ended_at'] != null ? DateTime.parse(j['ended_at'] as String) : null,
    steps: j['steps'] as int? ?? 0,
    distanceKm: double.tryParse(j['distance_km'].toString()) ?? 0,
    durationSec: j['duration_sec'] as int? ?? 0,
  );
}

class _LeaderboardEntry {
  final String name;
  final String? avatarColor;
  final int weeklySteps;
  final int rank;

  _LeaderboardEntry({
    required this.name,
    this.avatarColor,
    required this.weeklySteps,
    required this.rank,
  });

  factory _LeaderboardEntry.fromJson(Map<String, dynamic> j) =>
      _LeaderboardEntry(
        name: j['leaderboard_name'] ?? '?',
        avatarColor: j['avatar_color'],
        weeklySteps: int.tryParse(j['weekly_steps'].toString()) ?? 0,
        rank: int.tryParse(j['rank'].toString()) ?? 0,
      );
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen widget
// ─────────────────────────────────────────────────────────────────────────────

class StepChallengeScreen extends StatefulWidget {
  const StepChallengeScreen({super.key});

  @override
  State<StepChallengeScreen> createState() => _StepChallengeScreenState();
}

class _StepChallengeScreenState extends State<StepChallengeScreen>
    with SingleTickerProviderStateMixin {
  static const int _goal = 10000;
  static const Color _featureColor = Color(0xFFFFE0B2);

  // ── State ────────────────────────────────────────────────────────────────
  bool _loading = true;
  bool _pedometerDenied = false;
  bool _profileExists = false;

  _StepProfile? _profile;
  int _todaySteps = 0;
  List<_DaySteps> _history = [];
  List<_LeaderboardEntry> _leaderboard = [];
  int? _myRank;
  int _myWeeklySteps = 0;

  // Pedometer
  StreamSubscription<StepCount>? _stepSub;
  int _pedometerBaselineSteps = 0; // steps at midnight (approx)
  int _pedometerCurrentSteps = 0;
  bool _pedometerInitialized = false;

  // Tiered history
  _TieredHistory? _tieredHistory;

  // Active session
  bool _sessionActive = false;
  int? _sessionId;
  DateTime? _sessionStartTime;
  int _sessionSteps = 0;
  double _sessionDistanceKm = 0.0;
  Timer? _sessionTimer;
  StreamSubscription<Position>? _gpsSub;
  List<Map<String, dynamic>> _routePoints = [];
  int _sessionPedometerStart = 0;

  // Sync timer
  Timer? _syncTimer;
  DateTime? _lastSync;

  // Setup form
  final _nameController = TextEditingController();
  String _selectedColor = '#4CAF50';
  bool _showOnLeaderboard = true;
  bool _savingProfile = false;

  // Tab
  late final TabController _tabController;

  static const List<String> _presetColors = [
    '#4CAF50', // green
    '#2196F3', // blue
    '#FF5722', // deep orange
    '#9C27B0', // purple
    '#FF9800', // orange
    '#00BCD4', // cyan
  ];

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadAll();
  }

  @override
  void dispose() {
    _stepSub?.cancel();
    _syncTimer?.cancel();
    _gpsSub?.cancel();
    _sessionTimer?.cancel();
    _nameController.dispose();
    _tabController.dispose();
    super.dispose();
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  Future<void> _loadAll() async {
    setState(() => _loading = true);
    await Future.wait([
      _loadProfile(),
      _loadToday(),
      _loadHistory(),
      _loadLeaderboard(),
      _loadMyRank(),
      _loadTieredHistory(),
    ]);
    setState(() => _loading = false);
    _initPedometer();
    _startSyncTimer();
  }

  Future<void> _loadProfile() async {
    try {
      final resp = await ApiClient.get('/steps/profile');
      if (resp.isSuccess && resp.data != null) {
        setState(() {
          _profile = _StepProfile.fromJson(resp.data as Map<String, dynamic>);
          _profileExists = true;
        });
      } else {
        setState(() => _profileExists = false);
      }
    } catch (_) {
      setState(() => _profileExists = false);
    }
  }

  Future<void> _loadToday() async {
    try {
      final resp = await ApiClient.get('/steps/today');
      if (resp.isSuccess && resp.data != null) {
        final d = resp.data as Map<String, dynamic>;
        setState(() {
          _todaySteps = int.tryParse(d['steps'].toString()) ?? 0;
        });
      }
    } catch (_) {}
  }

  Future<void> _loadHistory() async {
    try {
      final resp = await ApiClient.get('/steps/history', queryParameters: {'days': '7'});
      if (resp.isSuccess && resp.data != null) {
        final list = resp.data as List<dynamic>;
        setState(() {
          _history = list.map((e) {
            final m = e as Map<String, dynamic>;
            return _DaySteps(
              DateTime.tryParse(m['log_date'].toString()) ?? DateTime.now(),
              int.tryParse(m['steps'].toString()) ?? 0,
            );
          }).toList();
        });
      }
    } catch (_) {}
  }

  Future<void> _loadLeaderboard() async {
    try {
      final resp = await ApiClient.get('/steps/leaderboard');
      if (resp.isSuccess && resp.data != null) {
        final list = resp.data as List<dynamic>;
        setState(() {
          _leaderboard = list
              .map((e) => _LeaderboardEntry.fromJson(e as Map<String, dynamic>))
              .toList();
        });
      }
    } catch (_) {}
  }

  Future<void> _loadMyRank() async {
    try {
      final resp = await ApiClient.get('/steps/my-rank');
      if (resp.isSuccess && resp.data != null) {
        final d = resp.data as Map<String, dynamic>;
        setState(() {
          _myRank = d['rank'] != null ? int.tryParse(d['rank'].toString()) : null;
          _myWeeklySteps = int.tryParse(d['weekly_steps']?.toString() ?? '0') ?? 0;
        });
      }
    } catch (_) {}
  }

  // ── Tiered history ────────────────────────────────────────────────────────

  Future<void> _loadTieredHistory() async {
    try {
      final resp = await ApiClient.get('/steps/history/tiered');
      if (resp.isSuccess && resp.data != null) {
        final d = resp.data as Map<String, dynamic>;
        _DaySteps parseEntry(Map<String, dynamic> e) => _DaySteps(
          DateTime.tryParse(e['period'].toString()) ?? DateTime.now(),
          int.tryParse(e['steps'].toString()) ?? 0,
        );
        setState(() {
          _tieredHistory = _TieredHistory(
            daily: (d['daily'] as List).map((e) => parseEntry(e as Map<String, dynamic>)).toList(),
            weekly: (d['weekly'] as List).map((e) => parseEntry(e as Map<String, dynamic>)).toList(),
            monthly: (d['monthly'] as List).map((e) => parseEntry(e as Map<String, dynamic>)).toList(),
          );
        });
      }
    } catch (_) {}
  }

  // ── GPS Session ───────────────────────────────────────────────────────────

  Future<void> _startSession() async {
    LocationPermission perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Location permission required for GPS tracking')),
      );
      return;
    }

    try {
      final resp = await ApiClient.post('/steps/sessions/start', body: {});
      if (!resp.isSuccess) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to start session')),
        );
        return;
      }
      final data = resp.data as Map<String, dynamic>;
      _sessionId = data['id'] as int;
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not start session')),
      );
      return;
    }

    setState(() {
      _sessionActive = true;
      _sessionStartTime = DateTime.now();
      _sessionSteps = 0;
      _sessionDistanceKm = 0.0;
      _routePoints = [];
      _sessionPedometerStart = _pedometerCurrentSteps;
    });

    _gpsSub = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 10,
      ),
    ).listen((Position position) {
      _routePoints.add({
        'lat': position.latitude,
        'lng': position.longitude,
        'timestamp': position.timestamp?.toIso8601String() ?? DateTime.now().toIso8601String(),
      });
      if (_routePoints.length >= 2) {
        final prev = _routePoints[_routePoints.length - 2];
        final curr = _routePoints[_routePoints.length - 1];
        final dist = Geolocator.distanceBetween(
          prev['lat'] as double,
          prev['lng'] as double,
          curr['lat'] as double,
          curr['lng'] as double,
        );
        setState(() => _sessionDistanceKm += dist / 1000.0);
      }
    });

    _sessionTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      final newSteps = _pedometerCurrentSteps - _sessionPedometerStart;
      if (newSteps >= 0) setState(() => _sessionSteps = newSteps);
    });
  }

  Future<void> _stopSession() async {
    _gpsSub?.cancel();
    _gpsSub = null;
    _sessionTimer?.cancel();
    _sessionTimer = null;

    final sid = _sessionId;
    final steps = _sessionSteps;
    final dist = _sessionDistanceKm;
    final points = List<Map<String, dynamic>>.from(_routePoints);

    setState(() {
      _sessionActive = false;
      _sessionId = null;
      _sessionStartTime = null;
    });

    if (sid != null) {
      try {
        await ApiClient.put('/steps/sessions/$sid/end', body: {
          'steps': steps,
          'distance_km': double.parse(dist.toStringAsFixed(3)),
          'route_points': points,
        });
        await _loadToday();
      } catch (_) {}
    }
  }

  String _formatDuration(int seconds) {
    final h = seconds ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    final s = seconds % 60;
    if (h > 0) return '${h}h ${m}m';
    if (m > 0) return '${m}m ${s}s';
    return '${s}s';
  }

  // ── Pedometer ─────────────────────────────────────────────────────────────

  Future<void> _initPedometer() async {
    final status = await Permission.activityRecognition.request();
    if (!status.isGranted) {
      setState(() => _pedometerDenied = true);
      return;
    }
    _stepSub = Pedometer.stepCountStream.listen(
      _onStepCount,
      onError: (e) => setState(() => _pedometerDenied = true),
      cancelOnError: false,
    );
  }

  void _onStepCount(StepCount event) {
    if (!_pedometerInitialized) {
      // Treat current pedometer value as baseline; accumulate from here
      _pedometerBaselineSteps = event.steps - _todaySteps;
      _pedometerInitialized = true;
    }
    _pedometerCurrentSteps = event.steps;
    final newTodaySteps = math.max(0, event.steps - _pedometerBaselineSteps);
    if (newTodaySteps != _todaySteps) {
      setState(() => _todaySteps = newTodaySteps);
      _maybeSyncSteps();
    }
  }

  // ── Sync timer ────────────────────────────────────────────────────────────

  void _startSyncTimer() {
    _syncTimer?.cancel();
    _syncTimer = Timer.periodic(const Duration(seconds: 60), (_) {
      _maybeSyncSteps();
    });
  }

  Future<void> _maybeSyncSteps() async {
    final now = DateTime.now();
    if (_lastSync != null && now.difference(_lastSync!).inSeconds < 58) return;
    _lastSync = now;
    try {
      final distanceKm = (_todaySteps * 0.0008);
      await ApiClient.post('/steps/sync', body: {
        'steps': _todaySteps,
        'distance_km': double.parse(distanceKm.toStringAsFixed(3)),
        'active_min': 0,
      });
    } catch (_) {
      // Silent fail — best effort
    }
  }

  // ── Profile save ──────────────────────────────────────────────────────────

  Future<void> _saveProfile() async {
    final name = _nameController.text.trim();
    if (name.length < 2 || name.length > 30) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Display name must be 2–30 characters')),
      );
      return;
    }
    setState(() => _savingProfile = true);
    try {
      final resp = await ApiClient.put('/steps/profile', body: {
        'leaderboard_name': name,
        'avatar_color': _selectedColor,
        'opt_out_leaderboard': !_showOnLeaderboard,
      });
      if (resp.isSuccess && resp.data != null) {
        setState(() {
          _profile = _StepProfile.fromJson(resp.data as Map<String, dynamic>);
          _profileExists = true;
        });
        await Future.wait([_loadLeaderboard(), _loadMyRank()]);
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Failed to save profile')),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Error saving profile')),
        );
      }
    } finally {
      setState(() => _savingProfile = false);
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return FeatureScreenScaffold(
      title: 'Step Challenge',
      icon: LucideIcons.footprints,
      color: _featureColor,
      heroTag: 'steps',
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : !_profileExists
              ? _buildSetupSection(context)
              : _buildMainScreen(context),
    );
  }

  // ── Setup section ─────────────────────────────────────────────────────────

  Widget _buildSetupSection(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Hero intro
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: [_featureColor, _featureColor.withOpacity(0.5)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Column(
              children: [
                const Icon(LucideIcons.footprints, size: 48, color: Colors.brown),
                const SizedBox(height: 12),
                Text(
                  'Join the Step Challenge!',
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  'Track your daily steps and compete on the hospital leaderboard. Choose a display name — your real name stays private.',
                  style: theme.textTheme.bodyMedium,
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
          const SizedBox(height: 32),

          Text('Your display name', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          TextField(
            controller: _nameController,
            maxLength: 30,
            decoration: InputDecoration(
              hintText: 'e.g. SpeedyRunner42',
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
              prefixIcon: const Icon(LucideIcons.user),
            ),
          ),
          const SizedBox(height: 24),

          Text('Avatar color', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          Row(
            children: _presetColors.map((hex) {
              final color = _hexToColor(hex);
              final selected = hex == _selectedColor;
              return GestureDetector(
                onTap: () => setState(() => _selectedColor = hex),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 200),
                  margin: const EdgeInsets.only(right: 12),
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: selected ? cs.primary : Colors.transparent,
                      width: 3,
                    ),
                    boxShadow: selected
                        ? [BoxShadow(color: color.withOpacity(0.5), blurRadius: 8, spreadRadius: 2)]
                        : [],
                  ),
                  child: selected ? const Icon(Icons.check, color: Colors.white, size: 18) : null,
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 24),

          SwitchListTile(
            title: const Text('Show me on leaderboard'),
            subtitle: const Text('Your display name will appear in the weekly top 20'),
            value: _showOnLeaderboard,
            onChanged: (v) => setState(() => _showOnLeaderboard = v),
            contentPadding: EdgeInsets.zero,
          ),
          const SizedBox(height: 32),

          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: _savingProfile ? null : _saveProfile,
              style: ElevatedButton.styleFrom(
                backgroundColor: cs.primary,
                foregroundColor: cs.onPrimary,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: _savingProfile
                  ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('Start Challenge', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }

  // ── Main screen ───────────────────────────────────────────────────────────

  Widget _buildMainScreen(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Column(
      children: [
        // Tabs
        Container(
          color: cs.surface,
          child: TabBar(
            controller: _tabController,
            tabs: const [
              Tab(text: 'My Steps', icon: Icon(LucideIcons.footprints, size: 18)),
              Tab(text: 'Leaderboard', icon: Icon(LucideIcons.trophy, size: 18)),
            ],
            labelColor: cs.primary,
            unselectedLabelColor: cs.onSurfaceVariant,
            indicatorColor: cs.primary,
          ),
        ),
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              _buildStepsTab(context),
              _buildLeaderboardTab(context),
            ],
          ),
        ),
      ],
    );
  }

  // ── Steps tab ─────────────────────────────────────────────────────────────

  Widget _buildStepsTab(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final progress = (_todaySteps / _goal).clamp(0.0, 1.0);
    final distanceKm = _todaySteps * 0.0008;

    return RefreshIndicator(
      onRefresh: _loadAll,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            // Permission warning
            if (_pedometerDenied)
              Container(
                margin: const EdgeInsets.only(bottom: 16),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.amber.shade100,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.amber.shade300),
                ),
                child: Row(
                  children: [
                    Icon(LucideIcons.alertTriangle, color: Colors.amber.shade700, size: 20),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Motion permission denied. Steps are not being tracked automatically. You can still view the leaderboard.',
                        style: TextStyle(color: Colors.amber.shade900, fontSize: 13),
                      ),
                    ),
                  ],
                ),
              ),

            // Step ring + counter
            Container(
              padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 24),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [_featureColor.withOpacity(0.6), _featureColor.withOpacity(0.2)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(24),
              ),
              child: Column(
                children: [
                  // Progress ring
                  SizedBox(
                    width: 160,
                    height: 160,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        CustomPaint(
                          size: const Size(160, 160),
                          painter: _RingPainter(
                            progress: progress,
                            trackColor: Colors.white.withOpacity(0.4),
                            progressColor: cs.primary,
                          ),
                        ),
                        Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              _todaySteps.toString(),
                              style: theme.textTheme.headlineLarge?.copyWith(
                                fontWeight: FontWeight.bold,
                                fontSize: 36,
                              ),
                            ),
                            Text(
                              'steps',
                              style: theme.textTheme.bodyMedium?.copyWith(
                                color: cs.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'Goal: $_goal steps',
                    style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  ),
                  const SizedBox(height: 4),
                  // Progress bar text
                  Text(
                    _todaySteps >= _goal
                        ? '🎉 Goal reached!'
                        : '${_goal - _todaySteps} steps to go',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: _todaySteps >= _goal ? Colors.green.shade700 : cs.onSurface,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Stats row
            Row(
              children: [
                _StatCard(
                  icon: LucideIcons.map,
                  label: 'Distance',
                  value: '${distanceKm.toStringAsFixed(2)} km',
                  color: cs.primaryContainer,
                ),
                const SizedBox(width: 12),
                _StatCard(
                  icon: LucideIcons.trophy,
                  label: 'This week rank',
                  value: _myRank != null ? '#$_myRank' : '—',
                  color: cs.secondaryContainer,
                ),
              ],
            ),
            const SizedBox(height: 24),

            // Active session card or Start button
            _sessionActive
              ? _buildActiveSessionCard(context)
              : Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: SizedBox(
                    width: double.infinity,
                    height: 52,
                    child: ElevatedButton.icon(
                      icon: const Icon(LucideIcons.play),
                      label: const Text('Start Walk / Run'),
                      onPressed: _startSession,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.green.shade600,
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                    ),
                  ),
                ),

            // History chart with tabs for day/week/month
            if (_tieredHistory != null) _buildTieredChart(context),
          ],
        ),
      ),
    );
  }

  Widget _buildActiveSessionCard(BuildContext context) {
    final theme = Theme.of(context);
    final elapsed = _sessionStartTime != null
      ? DateTime.now().difference(_sessionStartTime!).inSeconds
      : 0;

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.green.shade50,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.green.shade300, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 10, height: 10,
                decoration: const BoxDecoration(color: Colors.green, shape: BoxShape.circle),
              ),
              const SizedBox(width: 8),
              Text('Session Active', style: TextStyle(
                color: Colors.green.shade800,
                fontWeight: FontWeight.bold,
              )),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _SessionStat(label: 'Steps', value: '$_sessionSteps'),
              _SessionStat(label: 'Distance', value: '${_sessionDistanceKm.toStringAsFixed(2)} km'),
              _SessionStat(label: 'Duration', value: _formatDuration(elapsed)),
            ],
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            height: 44,
            child: ElevatedButton.icon(
              icon: const Icon(LucideIcons.square),
              label: const Text('Stop & Save'),
              onPressed: _stopSession,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.red.shade600,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTieredChart(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final th = _tieredHistory!;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (th.daily.isNotEmpty) ...[
          Text('Last 30 days (daily)', style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600, color: cs.onSurfaceVariant)),
          const SizedBox(height: 8),
          _buildBarChart(context, th.daily.take(30).toList(), labelFormat: 'MM/dd'),
          const SizedBox(height: 20),
        ],
        if (th.weekly.isNotEmpty) ...[
          Text('31–90 days (weekly avg)', style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600, color: cs.onSurfaceVariant)),
          const SizedBox(height: 8),
          _buildBarChart(context, th.weekly, labelFormat: 'Wk'),
          const SizedBox(height: 20),
        ],
        if (th.monthly.isNotEmpty) ...[
          Text('3+ months (monthly avg)', style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600, color: cs.onSurfaceVariant)),
          const SizedBox(height: 8),
          _buildBarChart(context, th.monthly, labelFormat: 'MMM'),
        ],
      ],
    );
  }

  Widget _buildBarChart(BuildContext context, List<_DaySteps> data, {String labelFormat = 'MM/dd'}) {
    final cs = Theme.of(context).colorScheme;
    if (data.isEmpty) return const SizedBox.shrink();

    final maxSteps = data.map((d) => d.steps).fold(1, (a, b) => b > a ? b : a);

    return Container(
      height: 120,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withOpacity(0.4),
        borderRadius: BorderRadius.circular(12),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: data.map((d) {
            final h = (d.steps / maxSteps * 70).clamp(4.0, 70.0);
            String label;
            if (labelFormat == 'MM/dd') {
              label = '${d.date.month}/${d.date.day}';
            } else if (labelFormat == 'Wk') {
              label = 'W${_weekOfYear(d.date)}';
            } else {
              const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              label = months[d.date.month - 1];
            }
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Container(
                    width: 20,
                    height: h,
                    decoration: BoxDecoration(
                      color: cs.primary.withOpacity(0.7),
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(label, style: TextStyle(fontSize: 8, color: cs.onSurfaceVariant)),
                ],
              ),
            );
          }).toList(),
        ),
      ),
    );
  }

  int _weekOfYear(DateTime date) {
    final dayOfYear = DateTime(date.year, date.month, date.day)
      .difference(DateTime(date.year, 1, 1)).inDays + 1;
    return ((dayOfYear - date.weekday + 10) / 7).floor();
  }

  // ── Leaderboard tab ───────────────────────────────────────────────────────

  Widget _buildLeaderboardTab(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final myName = _profile?.leaderboardName ?? '';

    return RefreshIndicator(
      onRefresh: () async {
        await Future.wait([_loadLeaderboard(), _loadMyRank()]);
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        children: [
          // My rank card
          Container(
            margin: const EdgeInsets.only(bottom: 20),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: [cs.primaryContainer, cs.primaryContainer.withOpacity(0.5)],
              ),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: cs.primary,
                    shape: BoxShape.circle,
                  ),
                  child: Center(
                    child: Text(
                      _myRank != null ? '#$_myRank' : '—',
                      style: TextStyle(
                        color: cs.onPrimary,
                        fontWeight: FontWeight.bold,
                        fontSize: 14,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        myName.isNotEmpty ? myName : 'You',
                        style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
                      ),
                      Text(
                        '$_myWeeklySteps steps this week',
                        style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                const Icon(LucideIcons.trophy, color: Colors.amber, size: 28),
              ],
            ),
          ),

          // Opt-out notice
          if (_profile?.optOut == true)
            Container(
              margin: const EdgeInsets.only(bottom: 16),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                'You are hidden from the leaderboard. Update your profile settings to appear.',
                style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
            ),

          // Top 20 list
          if (_leaderboard.isEmpty)
            Center(
              child: Padding(
                padding: const EdgeInsets.only(top: 32),
                child: Text(
                  'No data yet this week.\nBe the first to log steps!',
                  style: theme.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
                  textAlign: TextAlign.center,
                ),
              ),
            )
          else
            ...  _leaderboard.asMap().entries.map((entry) {
              final i = entry.key;
              final item = entry.value;
              final isMe = item.name == myName && myName.isNotEmpty;
              final avatarColor = item.avatarColor != null
                  ? _hexToColor(item.avatarColor!)
                  : cs.primary;

              return Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                decoration: BoxDecoration(
                  color: isMe
                      ? cs.primaryContainer.withOpacity(0.6)
                      : cs.surfaceContainerHighest.withOpacity(0.4),
                  borderRadius: BorderRadius.circular(12),
                  border: isMe ? Border.all(color: cs.primary, width: 1.5) : null,
                ),
                child: Row(
                  children: [
                    // Rank badge
                    SizedBox(
                      width: 36,
                      child: _buildRankBadge(context, item.rank),
                    ),
                    const SizedBox(width: 12),
                    // Avatar circle
                    CircleAvatar(
                      radius: 18,
                      backgroundColor: avatarColor.withOpacity(0.25),
                      child: Text(
                        item.name.isNotEmpty ? item.name[0].toUpperCase() : '?',
                        style: TextStyle(
                          color: avatarColor,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Text(
                                item.name,
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  fontWeight: FontWeight.w600,
                                  color: isMe ? cs.primary : null,
                                ),
                              ),
                              if (isMe) ...[
                                const SizedBox(width: 6),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: cs.primary,
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Text(
                                    'You',
                                    style: TextStyle(color: cs.onPrimary, fontSize: 10, fontWeight: FontWeight.bold),
                                  ),
                                ),
                              ],
                            ],
                          ),
                          Text(
                            '${_formatSteps(item.weeklySteps)} steps',
                            style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                          ),
                        ],
                      ),
                    ),
                    // Mini bar
                    if (_leaderboard.isNotEmpty)
                      SizedBox(
                        width: 60,
                        height: 8,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: LinearProgressIndicator(
                            value: item.weeklySteps / _leaderboard.first.weeklySteps.clamp(1, double.infinity),
                            backgroundColor: cs.surfaceContainerHighest,
                            valueColor: AlwaysStoppedAnimation(
                              isMe ? cs.primary : cs.primary.withOpacity(0.5),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }

  Widget _buildRankBadge(BuildContext context, int rank) {
    final cs = Theme.of(context).colorScheme;
    if (rank == 1) return const Text('🥇', style: TextStyle(fontSize: 22));
    if (rank == 2) return const Text('🥈', style: TextStyle(fontSize: 22));
    if (rank == 3) return const Text('🥉', style: TextStyle(fontSize: 22));
    return Text(
      '#$rank',
      style: TextStyle(
        fontWeight: FontWeight.bold,
        fontSize: 13,
        color: cs.onSurfaceVariant,
      ),
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  String _dateKey(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  String _formatSteps(int steps) {
    if (steps >= 1000) return '${(steps / 1000).toStringAsFixed(1)}k';
    return '$steps';
  }

  Color _hexToColor(String hex) {
    final h = hex.replaceAll('#', '');
    try {
      return Color(int.parse('FF$h', radix: 16));
    } catch (_) {
      return Colors.teal;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper widgets
// ─────────────────────────────────────────────────────────────────────────────

class _StatCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final Color color;

  const _StatCard({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: color.withOpacity(0.5),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 20),
            const SizedBox(height: 8),
            Text(
              value,
              style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
            ),
            Text(
              label,
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

class _SessionStat extends StatelessWidget {
  final String label;
  final String value;
  const _SessionStat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        Text(value, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold, color: Colors.green.shade800)),
        Text(label, style: theme.textTheme.bodySmall?.copyWith(color: Colors.green.shade600)),
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring progress painter
// ─────────────────────────────────────────────────────────────────────────────

class _RingPainter extends CustomPainter {
  final double progress;
  final Color trackColor;
  final Color progressColor;

  _RingPainter({
    required this.progress,
    required this.trackColor,
    required this.progressColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.width - 16) / 2;
    const strokeWidth = 10.0;

    final trackPaint = Paint()
      ..color = trackColor
      ..strokeWidth = strokeWidth
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    final progressPaint = Paint()
      ..color = progressColor
      ..strokeWidth = strokeWidth
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    canvas.drawCircle(center, radius, trackPaint);

    final sweepAngle = 2 * math.pi * progress;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      sweepAngle,
      false,
      progressPaint,
    );
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.progress != progress;
}
