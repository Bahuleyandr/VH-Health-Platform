import 'package:go_router/go_router.dart';

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:vhhealth_core/services/secure_storage.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/offline/api_cache_manager.dart';
import 'package:vhhealth/core/navigation/route_reachability.dart';
import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/connectivity_service.dart';
import 'package:vhhealth/core/services/health_sync_service.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/core/widgets/guest_sign_in_prompt.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/core/providers/dependents_provider.dart';
import 'package:vhhealth/core/providers/websocket_provider.dart';
import 'package:vhhealth/features/dashboard/providers/dashboard_provider.dart';
import 'package:vhhealth/features/dashboard/widgets/dashboard_header.dart';
import 'package:vhhealth/features/dashboard/widgets/dashboard_section.dart';
import 'package:vhhealth/features/dashboard/widgets/wellness_score_widget.dart';
import 'package:vhhealth/features/dashboard/widgets/health_insight_card.dart';
import 'package:vhhealth/features/dashboard/widgets/daily_checkin_sheet.dart';
import 'package:vhhealth/features/dashboard/widgets/command_center_today.dart';
import 'package:vhhealth/features/dashboard/widgets/stagger_entry.dart';
import 'package:vhhealth/features/dashboard/widgets/stats_strip.dart';
import 'package:vhhealth/features/dashboard/widgets/stat_detail_panels.dart';
import 'package:vhhealth/features/period_tracker/models/cycle_tracker.dart';
import 'package:vhhealth/features/profile/widgets/profile_switcher.dart';
import 'package:vhhealth/features/period_tracker/services/period_tracker_eligibility_loader.dart';
import 'package:vhhealth/core/widgets/live_region_snack_bar.dart';

enum _DashboardStatPanel { wellness, steps, points, period }

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final _secureStorage = VHSecureStorage.instance;
  late final String _name;
  late final String _hospitalNumber;
  late final bool _isGuestSession;
  String? lastAppointment;
  String? nextAppointment;
  String? cachedName;

  // Offline support
  String? _staleLabel;
  DateTime? _commandCenterCachedAt;
  StreamSubscription<bool>? _connectivitySub;
  late final DashboardProvider _dashboardProvider;

  // Gamification data
  Map<String, dynamic>? _healthPoints;
  bool _commandCenterLoading = false;
  String? _commandCenterError;
  Map<String, dynamic>? _commandCenterProfile;
  List<Map<String, dynamic>> _todayCards = [];
  bool _todayExpanded = false;
  _DashboardStatPanel? _expandedStatPanel;
  String? _lastActingAsUid;

  CycleTrackerSnapshot? _cycleTrackerSnapshot;
  bool _stepsHealthSyncInFlight = false;

  // Features list
  late final List<FeatureIconData> _features;
  Color _dialAccentColor = DashboardAccents.explore;

  @override
  void initState() {
    super.initState();
    final user = context.read<UserProvider>();
    _name = user.name;
    _hospitalNumber = user.hospitalNumber;
    _isGuestSession = user.isGuest;
    _features = _initializeFeatures();
    cachedName = _name;
    _dashboardProvider = DashboardProvider(isGuestSession: _isGuestSession)
      ..addListener(_handleDashboardProviderChanged);

    _connectivitySub = ConnectivityService.onChange.listen((isOnline) {
      if (isOnline && mounted && !_isGuestSession) {
        _fetchAndStoreDashboardFresh();
      }
    });

    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (!_isGuestSession) {
        _loadCachedData();
        _loadCycleTrackerSnapshot();
        _maybeFetchFromBackend();
        _attachRealtimeDashboardRefresh();
        _dashboardProvider.start();
      }
      // Daily mood check-in prompt — only shows if not already done today.
      if (mounted && !_isGuestSession) {
        maybeShowDailyCheckIn(context);
      }
    });
  }

  @override
  void dispose() {
    _connectivitySub?.cancel();
    _dashboardProvider.removeListener(_handleDashboardProviderChanged);
    _dashboardProvider.dispose();
    super.dispose();
  }

  void _handleDashboardProviderChanged() {
    if (mounted) setState(() {});
  }

  void _attachRealtimeDashboardRefresh() {
    try {
      _dashboardProvider.attachWebSocketProvider(
        context.read<WebSocketProvider>(),
      );
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Dashboard WS refresh attachment skipped: $e');
      }
    }
  }

  Future<void> _loadCycleTrackerSnapshot() async {
    if (_isGuestSession) return;
    try {
      final user = context.read<UserProvider>();
      final dependent = context.read<DependentsProvider>().activeDependent;
      final snapshot = await CycleTrackerStore.load(
        userPhone: user.phone,
        dependentUid: dependent?.uid,
      );
      if (!mounted) return;
      setState(() => _cycleTrackerSnapshot = snapshot);
    } catch (e) {
      if (kDebugMode) debugPrint('Cycle tracker load failed: $e');
    }
  }

  // ── Existing methods (unchanged) ───────────────────────────────

  List<FeatureIconData> _initializeFeatures() {
    return [
      FeatureIconData(
        icon: LucideIcons.heartPulse,
        svgAsset: 'assets/images/features/your-health.svg',
        label: 'Your Health',
        color: const Color(0xFF15B8A6),
        description: 'Records, prescriptions, consultations, and uploads',
        onTap: (ctx) => _openFeature(ctx, '/your-health'),
      ),
      FeatureIconData(
        icon: LucideIcons.calendarCheck,
        svgAsset: 'assets/images/features/appointments.svg',
        label: 'Appointments',
        color: const Color(0xFF3D8BFF),
        description: 'Book and manage visits',
        onTap: (ctx) => _openFeature(ctx, '/appointments'),
      ),
      FeatureIconData(
        icon: LucideIcons.pill,
        svgAsset: 'assets/images/features/pharmacy.svg',
        label: 'Pharmacy',
        color: const Color(0xFF61B15A),
        description: 'Medicines, refills, and delivery',
        onTap: (ctx) => _openFeature(ctx, '/pharmacy'),
      ),
      FeatureIconData(
        icon: LucideIcons.flaskConical,
        svgAsset: 'assets/images/features/investigations.svg',
        label: 'Tests & Reports',
        color: const Color(0xFF00A7C8),
        description: 'Lab tests, scans, reports, and bookings',
        onTap: (ctx) => _openFeature(ctx, '/investigations'),
      ),
      FeatureIconData(
        icon: LucideIcons.helpCircle,
        svgAsset: 'assets/images/features/ask-a-doubt.svg',
        label: 'Ask a Doubt',
        color: const Color(0xFFF4A261),
        description: 'Send a question to the hospital team',
        onTap: (ctx) => _openFeature(ctx, '/ask-a-doubt'),
      ),
      FeatureIconData(
        icon: LucideIcons.brainCircuit,
        svgAsset: 'assets/images/features/trivia.svg',
        label: 'Trivia',
        color: const Color(0xFF8E5CF7),
        description: 'Learn something useful and fun',
        onTap: (ctx) => _openFeature(ctx, '/trivia'),
      ),
      FeatureIconData(
        icon: LucideIcons.building2,
        svgAsset: 'assets/images/features/departments.svg',
        label: 'Departments',
        color: const Color(0xFF2F9E44),
        description: 'Find departments and doctors',
        onTap: (ctx) => _openFeature(ctx, '/departments'),
      ),
      FeatureIconData(
        icon: LucideIcons.info,
        svgAsset: 'assets/images/features/about-us.svg',
        label: 'About Us',
        color: const Color(0xFFE76F51),
        description: 'Hospital information and contact details',
        onTap: (ctx) => _openFeature(ctx, '/about-us'),
      ),
    ];
  }

  Future<void> _loadCachedData() async {
    if (_isGuestSession) return;
    try {
      final results = await Future.wait([
        _secureStorage.read(key: 'lastAppointment'),
        _secureStorage.read(key: 'nextAppointment'),
        _secureStorage.read(key: 'userName'),
      ]);
      if (mounted) {
        setState(() {
          lastAppointment = results[0];
          nextAppointment = results[1];
          cachedName = results[2] ?? _name;
        });
      }
    } catch (e) {
      debugPrint('Dashboard error: $e');
    }
  }

  Future<void> _maybeFetchFromBackend() async {
    if (_isGuestSession) return;
    try {
      await Future.delayed(const Duration(seconds: 1));
      if (mounted) unawaited(_fetchAndStoreDashboardFresh());
    } catch (e) {
      debugPrint('Dashboard error: $e');
    }
  }

  Future<void> _fetchAndStoreDashboard() async {
    if (_isGuestSession) return;
    if (mounted) {
      setState(() {
        _commandCenterLoading = true;
        _commandCenterError = null;
      });
    }
    try {
      final result = await ApiClient.cachedGet(
        '/portal/command-center',
        timeout: const Duration(seconds: 10),
      );
      if (!mounted) return;

      if (result.isSuccess) {
        final data = _asStringMap(result.data);
        _applyCommandCenter(
          data,
          staleLabel: result.staleLabel,
          cachedAt: result.cachedAt,
        );

        // Listen for fresh network data if cache was served first
        unawaited(
          result.onFresh?.then((fresh) async {
            final cached = await ApiCacheManager.load('/portal/command-center');
            if (!mounted) return;
            if (fresh.isSuccess) {
              _applyCommandCenter(
                _asStringMap(fresh.data),
                staleLabel: null,
                cachedAt: cached?.cachedAt,
              );
            }
          }),
        );
      } else {
        setState(() {
          _commandCenterLoading = false;
          _commandCenterError = result.failureMessage(
            'Today could not refresh right now.',
          );
        });
      }
    } catch (e) {
      debugPrint('Dashboard error: $e');
      if (mounted) {
        setState(() {
          _commandCenterLoading = false;
          _commandCenterError = 'Today could not refresh right now.';
        });
      }
    }
  }

  Future<void> _fetchAndStoreDashboardFresh() => _fetchAndStoreDashboard();

  void _applyCommandCenter(
    Map<String, dynamic> data, {
    required String? staleLabel,
    required DateTime? cachedAt,
  }) {
    final profile = _asStringMap(data['profile']);
    final services = _asStringMap(data['services']);
    final today = _asMapList(data['today']);
    final nextAppointmentData = _asStringMap(services['next_appointment']);
    final healthPoints = _asStringMap(services['health_points']);

    final nextAppointmentLabel = _appointmentSummary(nextAppointmentData);
    _dashboardProvider.applyCommandCenterAppointment(
      nextAppointmentData,
      notify: false,
    );
    setState(() {
      _staleLabel = staleLabel;
      _commandCenterCachedAt = cachedAt;
      _commandCenterLoading = false;
      _commandCenterError = null;
      _todayCards = today;
      _commandCenterProfile = profile.isEmpty ? null : profile;
      if (profile['name']?.toString().trim().isNotEmpty == true) {
        cachedName = profile['name'].toString();
      }
      _healthPoints = healthPoints.isEmpty ? null : healthPoints;
      nextAppointment = nextAppointmentLabel;
    });

    final name = profile['name']?.toString();
    if (name != null && name.isNotEmpty) {
      _secureStorage.write(key: 'userName', value: name);
    }
    if (nextAppointmentLabel != null && nextAppointmentLabel.isNotEmpty) {
      _secureStorage.write(key: 'nextAppointment', value: nextAppointmentLabel);
    }
  }

  Map<String, dynamic> _asStringMap(dynamic value) {
    if (value is Map<String, dynamic>) return value;
    if (value is Map) return Map<String, dynamic>.from(value);
    return {};
  }

  List<Map<String, dynamic>> _asMapList(dynamic value) {
    if (value is! List) return [];
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }

  int? _healthPointsTotal() {
    final data = _healthPoints;
    if (data == null) return null;
    final value = data['totalPoints'] ?? data['total'];
    if (value is num) return value.toInt();
    return int.tryParse(value?.toString() ?? '');
  }

  String? _healthTierLabel() {
    final data = _healthPoints;
    if (data == null) return null;
    final tier = data['currentTier'];
    if (tier is Map) return tier['name']?.toString();
    final text = tier?.toString().trim();
    return text == null || text.isEmpty ? null : text;
  }

  bool _canShowPeriodTracker(Dependent? activeDependent) {
    final profile = activeDependent == null ? _commandCenterProfile : null;
    final gender =
        activeDependent?.gender?.toString() ?? profile?['gender']?.toString();
    final birthday =
        activeDependent?.birthday?.toString() ??
        profile?['birthday']?.toString();
    return isPeriodTrackerEligible(gender: gender, birthday: birthday);
  }

  String? _appointmentSummary(Map<String, dynamic> appointment) {
    if (appointment.isEmpty) return null;
    final doctor = appointment['doctor_name']?.toString();
    final time = appointment['appointment_time']?.toString();
    final date = appointment['appointment_date']?.toString();
    final day = date == null || date.isEmpty
        ? null
        : DateTime.tryParse(date)?.toLocal();
    final label = day == null ? null : DateFormat.MMMd().format(day);
    final parts = [
      ?label,
      if (time != null && time.isNotEmpty) time,
    ].join(' at ');
    if (doctor != null && doctor.isNotEmpty) {
      return parts.isEmpty ? 'Dr. $doctor' : 'Dr. $doctor - $parts';
    }
    return parts.isEmpty ? 'Upcoming appointment' : parts;
  }

  Future<void> _openProfileEdit(BuildContext context) async {
    if (_isGuestSession) {
      unawaited(
        showGuestSignInPrompt(
          context,
          featureLabel: _featureLabelForRoute('/profile-edit'),
          returnTo: '/profile-edit',
        ),
      );
      return;
    }

    final changed = await context.push<bool>('/profile-edit');
    if (!mounted || changed != true) return;
    await _fetchAndStoreDashboardFresh();
  }

  void _openFeature(BuildContext context, String routeName) {
    final publicGuestRoutes = {'/about-us', '/departments', '/trivia'};
    if (_isGuestSession && !publicGuestRoutes.contains(routeName)) {
      showGuestSignInPrompt(
        context,
        featureLabel: _featureLabelForRoute(routeName),
        returnTo: routeName == '/your-health' ? '/health' : routeName,
      );
      return;
    }

    if (routeName == '/profile-edit') {
      unawaited(_openProfileEdit(context));
    } else if (routeName == '/your-health') {
      context.push('/health');
    } else if (routeName == '/records') {
      // Records merged into Your Health — open Hospital Docs tab (index 2)
      context.push('/health', extra: {'tab': 2});
    } else if (routeName == '/period-tracker') {
      unawaited(_openPeriodTracker(context));
    } else {
      context.push(routeName);
    }
  }

  Future<void> _openPeriodTracker(BuildContext context) async {
    final activeDependent = context.read<DependentsProvider>().activeDependent;
    if (!_canShowPeriodTracker(activeDependent)) return;
    await context.push('/period-tracker', extra: {'eligible': true});
    if (!mounted) return;
    await _loadCycleTrackerSnapshot();
  }

  void _openTodayCard(Map<String, dynamic> card) {
    final route = card['route']?.toString().trim();
    if (route == null || route.isEmpty) return;

    if (_isGuestSession) {
      showGuestSignInPrompt(
        context,
        featureLabel: card['title']?.toString() ?? 'This feature',
        returnTo: route,
      );
      return;
    }

    final tabValue = card['tab'];
    final tab = tabValue is num ? tabValue.toInt() : int.tryParse('$tabValue');
    if (route == '/health' && tab != null) {
      context.push(route, extra: {'tab': tab});
      return;
    }
    context.push(route);
  }

  void _toggleStatPanel(_DashboardStatPanel panel) {
    setState(() {
      _expandedStatPanel = _expandedStatPanel == panel ? null : panel;
    });
  }

  void _handleStepsStatTap() {
    final openingSteps = _expandedStatPanel != _DashboardStatPanel.steps;
    _toggleStatPanel(_DashboardStatPanel.steps);
    if (!openingSteps || _isGuestSession) return;
    unawaited(_promptHealthConnectForSteps());
  }

  Future<void> _promptHealthConnectForSteps() async {
    if (_stepsHealthSyncInFlight) return;
    _stepsHealthSyncInFlight = true;

    try {
      final healthSync = HealthSyncService.instance;
      var granted = await healthSync.hasActivityReadPermissions();
      if (!mounted) return;

      if (!granted) {
        final l = AppLocalizations.of(context)!;
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: l.dashboardHealthConnectPrompt,
            behavior: SnackBarBehavior.floating,
          ),
        );
        granted = await healthSync.requestActivityPermissions();
        if (!mounted) return;
      }

      if (!granted) {
        final l = AppLocalizations.of(context)!;
        ScaffoldMessenger.of(context).showSnackBar(
          LiveRegionSnackBar.build(
            message: l.dashboardHealthConnectPermissionDenied,
            behavior: SnackBarBehavior.floating,
          ),
        );
        return;
      }

      final synced = await healthSync.syncNow();
      await healthSync.startForegroundSync();
      final backgroundGranted = await healthSync
          .requestBackgroundReadPermissionIfAvailable();
      if (backgroundGranted) {
        await HealthSyncService.enableBackgroundSync();
      }
      if (!mounted) return;

      await _dashboardProvider.refreshSmartWidgets();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(
          message: synced > 0
              ? AppLocalizations.of(context)!.dashboardHealthConnectSynced
              : AppLocalizations.of(context)!.dashboardHealthConnectNoSamples,
          behavior: SnackBarBehavior.floating,
        ),
      );
    } catch (e) {
      if (kDebugMode) debugPrint('Steps Health Connect prompt failed: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(
          message: AppLocalizations.of(context)!
              .dashboardHealthConnectOpenFailed,
          behavior: SnackBarBehavior.floating,
        ),
      );
    } finally {
      _stepsHealthSyncInFlight = false;
    }
  }

  Widget _buildExpandedStatPanel(BuildContext context) {
    final panel = _expandedStatPanel;
    if (panel == null) return const SizedBox.shrink();

    switch (panel) {
      case _DashboardStatPanel.wellness:
        return const Column(
          children: [WellnessBreakdownPanel(), HealthInsightsStrip()],
        );
      case _DashboardStatPanel.steps:
        return StepsBreakdownPanel(
          stepsToday: _dashboardProvider.stepsToday,
          stepGoal: _dashboardProvider.stepGoal,
          distanceTodayMeters: _dashboardProvider.distanceTodayMeters,
          activityLevelLabel: _dashboardProvider.activityLevelLabel,
          onOpenFull: () => _openFeature(context, '/steps'),
        );
      case _DashboardStatPanel.points:
        return PointsBreakdownPanel(
          summary: _healthPoints,
          onOpenFull: () => _openFeature(context, '/health-points'),
        );
      case _DashboardStatPanel.period:
        return CycleBreakdownPanel(
          snapshot: _cycleTrackerSnapshot,
          onRecordPeriodStart: _recordPeriodStart,
          onOpenFull: () => _openFeature(context, '/period-tracker'),
        );
    }
  }

  Future<void> _recordPeriodStart(DateTime startDate) async {
    if (_isGuestSession) return;
    try {
      final user = context.read<UserProvider>();
      final dependent = context.read<DependentsProvider>().activeDependent;
      final current =
          _cycleTrackerSnapshot ??
          await CycleTrackerStore.load(
            userPhone: user.phone,
            dependentUid: dependent?.uid,
          );
      final updated = CycleTrackerSnapshot(
        ownerKey: current.ownerKey,
        lastPeriodStart: CycleTrackerSnapshot.dateOnly(startDate),
        cycleLength: current.cycleLength,
        periodLength: current.periodLength,
      );
      await CycleTrackerStore.save(updated);
      if (!mounted) return;
      setState(() => _cycleTrackerSnapshot = updated);
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(
          message: AppLocalizations.of(context)!
              .periodTrackerCycleStartRecorded,
        ),
      );
    } catch (e) {
      if (kDebugMode) debugPrint('Cycle tracker save failed: $e');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        LiveRegionSnackBar.build(
          message: AppLocalizations.of(context)!
              .periodTrackerCycleStartSaveFailed,
        ),
      );
    }
  }

  String _featureLabelForRoute(String routeName) {
    return switch (routeName) {
      '/your-health' || '/health' || '/records' => 'Your health records',
      '/appointments' => 'Appointments',
      '/pharmacy' => 'Pharmacy',
      '/investigations' => 'Tests & Reports',
      '/ask-a-doubt' => 'Ask a Doubt',
      '/steps' => 'Step Challenge',
      '/vitals' => 'Vitals',
      '/refill' => 'Refills',
      '/family' => 'Family',
      '/profile-edit' => 'Profile',
      '/health-points' => 'Health Points',
      '/period-tracker' => 'Period Tracker',
      '/portal/maternity/timeline' => 'Maternity',
      '/portal/bills' => 'Bills',
      '/portal/lab-results' => 'Lab Results',
      '/portal/diagnostic-results' => 'Imaging and Pathology Reports',
      '/portal/referrals' => 'Referrals',
      '/portal/tpa/claims' => 'Insurance Claims',
      '/portal/messages' => 'Messages',
      _ => 'This feature',
    };
  }

  Future<void> _triggerSOS() async {
    await SOSService.triggerWithFeedback(context);
  }

  /// Pull-to-refresh handler. Re-runs the dashboard fetch + the smart
  /// widget poll + the appointment poll in parallel. Returns when all
  /// three settle so the RefreshIndicator spinner stays up exactly long
  /// enough to feel intentional.
  Future<void> _refreshAll() async {
    if (_isGuestSession) return;
    await Future.wait([
      _fetchAndStoreDashboardFresh(),
      _dashboardProvider.refreshSmartWidgets(),
      _dashboardProvider.refreshAppointments(),
      _loadCycleTrackerSnapshot(),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final nameToShow = cachedName ?? _name;
    final isGuest = context.watch<UserProvider>().isGuest;
    final iconScale = context.watch<ThemeProvider>().iconScale;
    final unread = !isGuest
        ? context.watch<NotificationProvider>().unreadCount
        : 0;
    final activeDependent = !isGuest
        ? context.watch<DependentsProvider>().activeDependent
        : null;
    final activeDependentUid = activeDependent?.uid;
    final activeProfileChanged =
        !_isGuestSession && _lastActingAsUid != activeDependentUid;
    if (activeProfileChanged) {
      _lastActingAsUid = activeDependentUid;
      SchedulerBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        setState(() {
          _commandCenterProfile = null;
          _commandCenterCachedAt = null;
          _cycleTrackerSnapshot = null;
          if (_expandedStatPanel == _DashboardStatPanel.period) {
            _expandedStatPanel = null;
          }
        });
        _dashboardProvider.clearProfileScopedState();
        _loadCycleTrackerSnapshot();
        _fetchAndStoreDashboardFresh();
        _dashboardProvider.refreshSmartWidgets();
        _dashboardProvider.refreshAppointments();
      });
    }

    final hasTodaySection = !isGuest;
    final hasStatsSection = !isGuest;
    final activeStatPanel = _expandedStatPanel;
    final healthPointsTotal = _healthPointsTotal();
    final healthTierLabel = _healthTierLabel();
    final showPeriodTracker = activeProfileChanged && activeDependent == null
        ? false
        : _canShowPeriodTracker(activeDependent);

    // Build the snapshot row labels.
    final nextApptLabel = _formatNextApptLabel();
    final lastVitalsLabel = _formatLastVitalsLabel();

    // Each top-level child gets a stagger index so the page assembles
    // with a brief cascade. Using a counter so we don't have to renumber
    // when sections show / hide.
    var staggerIdx = 0;
    StaggerEntry stagger(Widget child) =>
        StaggerEntry(index: staggerIdx++, child: child);

    return Scaffold(
      body: LogoBackground(
        child: SafeArea(
          child: Column(
            children: [
              // Custom greeting header — now also surfaces a snapshot
              // row of "about you right now" facts.
              DashboardHeader(
                name: nameToShow,
                isGuest: isGuest,
                hospitalNumber: _hospitalNumber,
                unreadNotifications: unread,
                nextAppointmentLabel: nextApptLabel,
                lastVitalsLabel: lastVitalsLabel,
                onProfileTap: () => _openProfileEdit(context),
              ),

              // Profile switcher (guardian → minor dependents). Self-hides
              // when the user has no linked dependents.
              if (!isGuest) const ProfileSwitcher(),

              // Offline / stale-data banner (pinned, stays visible on scroll).
              OfflineBanner(
                staleLabel: _staleLabel,
                cachedAt: _oldestCachedAt(
                  _commandCenterCachedAt,
                  _dashboardProvider.appointmentCachedAt,
                ),
              ),

              Expanded(
                child: RefreshIndicator(
                  onRefresh: _refreshAll,
                  child: SingleChildScrollView(
                    physics: isGuest
                        ? const NeverScrollableScrollPhysics()
                        : const AlwaysScrollableScrollPhysics(),
                    padding: EdgeInsets.only(bottom: isGuest ? 96 : 128),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        // ── At a glance (stats strip) ────────────────────
                        if (hasStatsSection)
                          stagger(
                            StatsStrip(
                              wellnessScore: _dashboardProvider.wellnessScore,
                              healthPoints: healthPointsTotal,
                              healthTier: healthTierLabel,
                              stepsToday: _dashboardProvider.stepsToday,
                              stepGoal: _dashboardProvider.stepGoal,
                              cycleEstimate: _cycleTrackerSnapshot?.estimate(),
                              wellnessExpanded:
                                  activeStatPanel ==
                                  _DashboardStatPanel.wellness,
                              stepsExpanded:
                                  activeStatPanel == _DashboardStatPanel.steps,
                              pointsExpanded:
                                  activeStatPanel == _DashboardStatPanel.points,
                              periodExpanded:
                                  activeStatPanel == _DashboardStatPanel.period,
                              showPeriodTracker: showPeriodTracker,
                              onWellnessTap: () => _toggleStatPanel(
                                _DashboardStatPanel.wellness,
                              ),
                              onPointsTap: () =>
                                  _toggleStatPanel(_DashboardStatPanel.points),
                              onStepsTap: _handleStepsStatTap,
                              onPeriodTap: () =>
                                  _toggleStatPanel(_DashboardStatPanel.period),
                            ),
                          ),

                        // ── Expanded stat details ────────────────────────
                        AnimatedSize(
                          duration: const Duration(milliseconds: 220),
                          curve: Curves.easeOutCubic,
                          child: _buildExpandedStatPanel(context),
                        ),

                        // ── Explore ──────────────────────────────────────
                        stagger(
                          DashboardSection(
                            label: l10n.dashboardExploreSection,
                            accent: _dialAccentColor,
                            tinted: false,
                            child: CircularFeatureDial(
                              features: _features,
                              iconScale: iconScale,
                              onFocusColorChanged: (color) {
                                if (mounted) {
                                  setState(() => _dialAccentColor = color);
                                }
                              },
                              onCenterDoubleTap: () =>
                                  _openFeature(context, '/health-points'),
                            ),
                          ),
                        ),

                        if (!isGuest)
                          stagger(
                            DashboardSection(
                              label: l10n.dashboardCareToolsSection,
                              accent: DashboardAccents.quickActions,
                              child: LayoutBuilder(
                                builder: (context, constraints) {
                                  const gap = 10.0;
                                  final itemWidth =
                                      (constraints.maxWidth - gap) / 2;
                                  return Wrap(
                                    spacing: gap,
                                    runSpacing: gap,
                                    children: patientDashboardCareRoutes
                                        .map(
                                          (route) => SizedBox(
                                            width: itemWidth,
                                            child: _CareToolButton(
                                              route: route,
                                              label: _careToolLabel(
                                                l10n,
                                                route,
                                              ),
                                              icon: _careToolIcon(route),
                                              onTap: () =>
                                                  _openFeature(context, route),
                                            ),
                                          ),
                                        )
                                        .toList(growable: false),
                                  );
                                },
                              ),
                            ),
                          ),

                        // ── Today ────────────────────────────────────────
                        if (hasTodaySection)
                          stagger(
                            DashboardSection(
                              label: l10n.dashboardTodaySection,
                              accent: DashboardAccents.today,
                              tinted: true,
                              child: _TodayCommandPanel(
                                expanded: _todayExpanded,
                                cards: _todayCards,
                                loading: _commandCenterLoading,
                                error: _commandCenterError,
                                onToggle: () => setState(
                                  () => _todayExpanded = !_todayExpanded,
                                ),
                                onRetry: _fetchAndStoreDashboard,
                                onOpenCard: _openTodayCard,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      floatingActionButton: _todayExpanded
          ? FloatingActionButton.small(
              heroTag: 'sos',
              tooltip: l10n.authSosTooltip,
              backgroundColor: Colors.red,
              onPressed: _triggerSOS,
              child: const Icon(Icons.favorite),
            )
          : FloatingActionButton(
              heroTag: 'sos',
              tooltip: l10n.authSosTooltip,
              backgroundColor: Colors.red,
              onPressed: _triggerSOS,
              child: const Icon(Icons.favorite),
            ),
      floatingActionButtonLocation: _todayExpanded
          ? const _LiftedEndFloatLocation(220)
          : FloatingActionButtonLocation.endFloat,
    );
  }

  /// Builds the "Next visit" snapshot label shown in the header. Falls
  /// back through the available data sources: today's appointment first,
  /// then the upcoming-appointment detail, then the legacy string from
  /// the dashboard endpoint (which arrives as an ISO timestamp; we
  /// reformat to "in N days" for readability).
  String? _formatNextApptLabel() {
    if (_dashboardProvider.todayAppointment != null) return 'Visit today';
    final detail = _dashboardProvider.nextAppointmentDetail;
    if (detail != null) {
      final daysAway = detail['daysAway'] ?? detail['days_away'];
      if (daysAway is num) {
        final n = daysAway.toInt();
        if (n <= 0) return 'Visit today';
        if (n == 1) return 'Visit tomorrow';
        return 'Visit in $n days';
      }
    }
    final next = nextAppointment;
    if (next != null && next.isNotEmpty) {
      // Try parsing as ISO; fall back to raw string if the backend
      // sent something already formatted.
      final parsed = DateTime.tryParse(next);
      if (parsed != null) {
        final today = DateTime.now();
        final diff = DateTime(
          parsed.year,
          parsed.month,
          parsed.day,
        ).difference(DateTime(today.year, today.month, today.day)).inDays;
        if (diff <= 0) return 'Visit today';
        if (diff == 1) return 'Visit tomorrow';
        if (diff < 14) return 'Visit in $diff days';
        return 'Visit ${DateFormat.MMMd().format(parsed)}';
      }
      return 'Next: $next';
    }
    return null;
  }

  /// "Last vitals" snapshot label. We only know the last vitals time
  /// once the user opens the Vitals screen (which fetches its own
  /// history). Until that endpoint is queryable from here we return a
  /// gentle nudge so the chip surfaces *something* useful.
  String? _formatLastVitalsLabel() {
    return null;
  }

  String _careToolLabel(AppLocalizations l10n, String route) {
    return switch (route) {
      '/chatbot' => l10n.symptomCheckerTitle,
      '/calendar' => l10n.calendarFullAccess,
      '/refill' => l10n.refillTitle,
      '/family' => l10n.familyTitle,
      '/reminders' => l10n.medicationRemindersTitle,
      '/portal/maternity/timeline' => l10n.ancTimelineTitle,
      _ => throw ArgumentError.value(route, 'route', 'Unknown care tool'),
    };
  }

  IconData _careToolIcon(String route) {
    return switch (route) {
      '/chatbot' => LucideIcons.stethoscope,
      '/calendar' => LucideIcons.calendarDays,
      '/refill' => LucideIcons.refreshCcw,
      '/family' => LucideIcons.users,
      '/reminders' => LucideIcons.bellRing,
      '/portal/maternity/timeline' => LucideIcons.baby,
      _ => LucideIcons.circle,
    };
  }
}

class _CareToolButton extends StatelessWidget {
  final String route;
  final String label;
  final IconData icon;
  final VoidCallback onTap;

  const _CareToolButton({
    required this.route,
    required this.label,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: label,
      child: Material(
        color: colorScheme.surface.withValues(alpha: 0.78),
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          key: ValueKey('dashboard-care-tool-$route'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
            child: Row(
              children: [
                Icon(icon, size: 20, color: colorScheme.primary),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

DateTime? _oldestCachedAt(DateTime? first, DateTime? second) {
  if (first == null) return second;
  if (second == null) return first;
  return first.isBefore(second) ? first : second;
}

class _LiftedEndFloatLocation extends StandardFabLocation
    with FabEndOffsetX, FabFloatOffsetY {
  final double lift;

  const _LiftedEndFloatLocation(this.lift);

  @override
  double getOffsetY(
    ScaffoldPrelayoutGeometry scaffoldGeometry,
    double adjustment,
  ) {
    return super.getOffsetY(scaffoldGeometry, adjustment) - lift;
  }
}

class _TodayCommandPanel extends StatelessWidget {
  final bool expanded;
  final List<Map<String, dynamic>> cards;
  final bool loading;
  final String? error;
  final VoidCallback onToggle;
  final VoidCallback onRetry;
  final ValueChanged<Map<String, dynamic>> onOpenCard;

  const _TodayCommandPanel({
    required this.expanded,
    required this.cards,
    required this.loading,
    required this.error,
    required this.onToggle,
    required this.onRetry,
    required this.onOpenCard,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final count = cards.length;
    final summary = loading && count == 0
        ? 'Refreshing your next steps'
        : error != null && count == 0
        ? 'Tap to retry Today'
        : count == 0
        ? 'No urgent items right now'
        : count == 1
        ? '1 item waiting'
        : '$count items waiting';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onToggle,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
            child: Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: DashboardAccents.today.withValues(alpha: 0.18),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    loading ? LucideIcons.refreshCw : LucideIcons.calendarDays,
                    size: 22,
                    color: DashboardAccents.today,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        expanded ? 'Hide Today' : 'Show Today',
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        summary,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(
                  expanded ? LucideIcons.chevronUp : LucideIcons.chevronDown,
                  color: cs.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
          child: expanded
              ? Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: CommandCenterToday(
                    cards: cards,
                    loading: loading,
                    error: error,
                    onRetry: onRetry,
                    onOpenCard: onOpenCard,
                  ),
                )
              : const SizedBox.shrink(),
        ),
      ],
    );
  }
}
