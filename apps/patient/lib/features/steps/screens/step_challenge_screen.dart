// Step Challenge screen — owns the data fetching and the GPS/pedometer
// walk session; each visual section (profile, today, walk control,
// history, leaderboard, rewards) renders from features/steps/widgets/.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:pedometer/pedometer.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/widgets/feature_screen_scaffold.dart';
import 'package:vhhealth/features/steps/models/step_models.dart';
import 'package:vhhealth/features/steps/services/walk_session_checkpoint_store.dart';
import 'package:vhhealth/features/steps/widgets/step_history_section.dart';
import 'package:vhhealth/features/steps/widgets/step_leaderboard_section.dart';
import 'package:vhhealth/features/steps/widgets/step_profile_section.dart';
import 'package:vhhealth/features/steps/widgets/step_rewards_section.dart';
import 'package:vhhealth/features/steps/widgets/step_today_card.dart';
import 'package:vhhealth/features/steps/widgets/step_walk_control.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

class StepChallengeScreen extends StatefulWidget {
  const StepChallengeScreen({super.key});

  @override
  State<StepChallengeScreen> createState() => _StepChallengeScreenState();
}

class _StepChallengeScreenState extends State<StepChallengeScreen>
    with WidgetsBindingObserver {
  // ── Profile ──
  StepProfile? _profile;
  bool _loadingProfile = true;
  bool _savingProfile = false;
  bool _editingProfile = false;
  final _nameController = TextEditingController();
  final _goalController = TextEditingController(text: '8000');
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
  List<DailyRow> _daily = [];
  List<WeeklyRow> _weekly = [];
  List<MonthlyRow> _monthly = [];
  bool _loadingHistory = true;

  // ── Leaderboard ──
  List<LeaderEntry> _leaderboard = [];
  Map<String, dynamic>? _myRank;
  bool _loadingLeaderboard = true;

  // ── Rewards ──
  List<Reward> _rewards = [];
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
  final _walkCheckpointStore = WalkSessionCheckpointStore();

  // ── Pedometer (hardware step counter) ──
  StreamSubscription<StepCount>? _pedometerSubscription;
  int? _pedometerBaseline;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initPedometer();
    unawaited(_reconcilePendingWalk(showFeedback: false));
    _fetchAll();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(_checkpointWalk());
    }
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
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_checkpointWalk());
    _nameController.dispose();
    _goalController.dispose();
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
          final p = StepProfile.fromJson(profileData);
          setState(() {
            _profile = p;
            _nameController.text = p.displayName;
            _goalController.text = p.dailyGoal.toString();
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
              .map(DailyRow.fromJson)
              .toList();
          _weekly = (d['weekly'] as List? ?? [])
              .cast<Map<String, dynamic>>()
              .map(WeeklyRow.fromJson)
              .toList();
          _monthly = (d['monthly'] as List? ?? [])
              .cast<Map<String, dynamic>>()
              .map(MonthlyRow.fromJson)
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
              .map(LeaderEntry.fromJson)
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
              .map(Reward.fromJson)
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
    final dailyGoal = int.tryParse(_goalController.text.trim());
    if (dailyGoal == null) {
      _showError('Daily step target must be a number');
      return;
    }
    if (dailyGoal < 1000 || dailyGoal > 100000) {
      _showError('Daily step target must be between 1,000 and 100,000');
      return;
    }
    setState(() => _savingProfile = true);
    try {
      final resp = await ApiClient.put(
        '/steps/profile',
        body: {
          'displayName': name,
          'displayColor': _editColor,
          'dailyGoal': dailyGoal,
          'optedIn': _profile?.optedIn ?? true,
        },
      );
      if (resp.isSuccess) {
        if (mounted) setState(() => _editingProfile = false);
        await _fetchProfile();
        _showSuccess('Profile saved');
      } else {
        _showError(resp.failureMessage('Failed to save profile'));
      }
    } catch (e) {
      _showError('Failed to save profile');
    } finally {
      if (mounted) setState(() => _savingProfile = false);
    }
  }

  // ─── GPS walk ────────────────────────────────────────────────────────────

  Future<void> _startWalk() async {
    if (!await _reconcilePendingWalk(showFeedback: true)) return;

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
        _showError(resp.failureMessage('Failed to start session'));
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
      await _checkpointWalk();

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
        if (!mounted) return;
        setState(() => _elapsedSeconds++);
        if (_elapsedSeconds % 5 == 0) unawaited(_checkpointWalk());
      });
    } catch (e) {
      _showError('Failed to start walk');
    }
  }

  Future<void> _stopWalk() async {
    await _checkpointWalk();
    unawaited(_positionStream?.cancel());
    _positionStream = null;
    _elapsedTimer?.cancel();
    _elapsedTimer = null;

    final sessionId = _activeSessionId;
    final steps = _estimatedSteps;
    final distance = _totalDistanceMeters;
    final duration = _elapsedSeconds;

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
        await _walkCheckpointStore.clear();
        if (mounted) {
          setState(() {
            _isWalking = false;
            _activeSessionId = null;
            _totalDistanceMeters = 0;
            _estimatedSteps = 0;
            _elapsedSeconds = 0;
            _lastPosition = null;
            _pedometerBaseline = null;
          });
        }
        final distKm = (distance / 1000).toStringAsFixed(2);
        _showSuccess('Walk done! $steps steps • ${distKm}km');
        await Future.wait([_fetchHistory(), _fetchLeaderboard()]);
      } else {
        if (mounted) setState(() => _isWalking = false);
        _showError(
          '${resp.failureMessage('Failed to save walk data')}. Your walk is saved locally and will retry before the next walk.',
        );
      }
    } catch (e) {
      if (mounted) setState(() => _isWalking = false);
      _showError(
        'Failed to save walk data. Your walk is saved locally and will retry before the next walk.',
      );
    }
  }

  Future<void> _checkpointWalk() async {
    final sessionId = _activeSessionId;
    if (sessionId == null) return;
    try {
      await _walkCheckpointStore.save(
        WalkSessionCheckpoint(
          sessionId: sessionId,
          steps: _estimatedSteps,
          distanceMeters: _totalDistanceMeters,
          durationSeconds: _elapsedSeconds,
          savedAt: DateTime.now(),
        ),
      );
    } catch (_) {
      debugPrint('Unable to checkpoint the active walk');
    }
  }

  Future<bool> _reconcilePendingWalk({required bool showFeedback}) async {
    try {
      final checkpoint = await _walkCheckpointStore.read();
      if (checkpoint == null) return true;
      final resp = await ApiClient.post(
        '/steps/session/stop',
        body: {
          'sessionId': checkpoint.sessionId,
          'steps': checkpoint.steps,
          'distanceMeters': checkpoint.distanceMeters,
          'durationSeconds': checkpoint.durationSeconds,
        },
      );
      if (!resp.isSuccess) {
        if (showFeedback) {
          _showError(
            'Your previous walk is still saved locally. Connect to the server before starting another walk.',
          );
        }
        return false;
      }
      await _walkCheckpointStore.clear();
      if (_activeSessionId == checkpoint.sessionId && mounted) {
        setState(() {
          _activeSessionId = null;
          _totalDistanceMeters = 0;
          _estimatedSteps = 0;
          _elapsedSeconds = 0;
        });
      }
      if (showFeedback) _showSuccess('Your previous walk was recovered');
      unawaited(_fetchHistory());
      return true;
    } catch (_) {
      if (showFeedback) {
        _showError(
          'Your previous walk is still saved locally. Connect to the server before starting another walk.',
        );
      }
      return false;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      LiveRegionSnackBar.build(
        message: msg,
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  void _showSuccess(String msg) {
    if (!mounted) return;
    final colors = Theme.of(context).colorScheme;
    ScaffoldMessenger.of(context).showSnackBar(
      LiveRegionSnackBar.build(
        message: msg,
        backgroundColor: colors.tertiary,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  /// Today's row out of the fetched daily history, if present.
  DailyRow? get _todayRow {
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
    final colors = Theme.of(context).colorScheme;
    return FeatureScreenScaffold(
      title: 'Step Challenge 🏃',
      icon: LucideIcons.footprints,
      color: colors.tertiary,
      heroTag: 'steps',
      child: RefreshIndicator(
        onRefresh: _fetchAll,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            StepProfileSection(
              profile: _profile,
              loadingProfile: _loadingProfile,
              savingProfile: _savingProfile,
              editingProfile: _editingProfile,
              nameController: _nameController,
              goalController: _goalController,
              editColor: _editColor,
              colorOptions: _colorOptions,
              onEditPressed: () => setState(() {
                _editingProfile = true;
                _nameController.text = _profile?.displayName ?? '';
                _goalController.text = (_profile?.dailyGoal ?? 8000).toString();
                _editColor = _profile?.displayColor ?? '#2196F3';
              }),
              onCancelEdit: () => setState(() {
                _editingProfile = false;
                _nameController.text = _profile?.displayName ?? '';
                _goalController.text = (_profile?.dailyGoal ?? 8000).toString();
                _editColor = _profile?.displayColor ?? '#2196F3';
              }),
              onColorSelected: (hex) => setState(() => _editColor = hex),
              onSave: _saveProfile,
            ),
            const SizedBox(height: 16),
            StepTodayCard(
              today: _todayRow,
              dailyGoal: _profile?.dailyGoal ?? 8000,
            ),
            const SizedBox(height: 16),
            StepWalkControl(
              isWalking: _isWalking,
              estimatedSteps: _estimatedSteps,
              totalDistanceMeters: _totalDistanceMeters,
              elapsedSeconds: _elapsedSeconds,
              onStart: _startWalk,
              onStop: _stopWalk,
            ),
            const SizedBox(height: 16),
            StepHistorySection(
              daily: _daily,
              weekly: _weekly,
              monthly: _monthly,
              loading: _loadingHistory,
            ),
            const SizedBox(height: 16),
            StepLeaderboardSection(
              leaderboard: _leaderboard,
              myRank: _myRank,
              loading: _loadingLeaderboard,
            ),
            const SizedBox(height: 16),
            StepRewardsSection(rewards: _rewards, loading: _loadingRewards),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }
}
