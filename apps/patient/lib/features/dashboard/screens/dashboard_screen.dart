import 'package:go_router/go_router.dart';

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:intl/intl.dart';
import 'package:firebase_auth/firebase_auth.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/connectivity_service.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/providers/notification_provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/features/dashboard/widgets/dashboard_header.dart';
import 'package:vhhealth/features/dashboard/widgets/dashboard_section.dart';
import 'package:vhhealth/features/dashboard/widgets/feature_grid.dart';
import 'package:vhhealth/features/dashboard/widgets/next_visit_progress_widget.dart';
import 'package:vhhealth/features/dashboard/widgets/health_points_widget.dart';
import 'package:vhhealth/features/dashboard/widgets/wellness_score_widget.dart';
import 'package:vhhealth/features/dashboard/widgets/health_insight_card.dart';
import 'package:vhhealth/features/dashboard/widgets/daily_checkin_sheet.dart';
import 'package:vhhealth/features/dashboard/widgets/quick_action_button.dart';
import 'package:vhhealth/features/dashboard/widgets/today_appointment_card.dart';
import 'package:vhhealth/features/dashboard/widgets/appointment_card.dart';
import 'package:vhhealth/features/dashboard/widgets/smart_pharmacy_card.dart';
import 'package:vhhealth/features/dashboard/widgets/smart_investigation_card.dart';
import 'package:vhhealth/features/dashboard/widgets/smart_prescription_card.dart';
import 'package:vhhealth/features/dashboard/widgets/stagger_entry.dart';
import 'package:vhhealth/features/dashboard/widgets/stats_strip.dart';
import 'package:vhhealth/features/profile/widgets/profile_switcher.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final _secureStorage = const FlutterSecureStorage();
  late final String _phone;
  late final String _name;
  late final String _hospitalNumber;
  late final bool _isGuestSession;
  String? lastAppointment;
  String? nextAppointment;
  String? cachedName;

  // Offline support
  String? _staleLabel;
  StreamSubscription<bool>? _connectivitySub;

  // Real-time appointment polling
  Timer? _appointmentPoller;
  Map<String, dynamic>? _todayAppointment;
  String _appointmentStatus = '';
  int _apptPollFailures = 0;

  // Smart widget data
  Timer? _smartWidgetPoller;
  int _smartPollFailures = 0;
  Map<String, dynamic>? _activePharmacyOrder;
  Map<String, dynamic>? _activeInvestigationBooking;
  Map<String, dynamic>? _recentPrescription;

  // Gamification data
  Map<String, dynamic>? _nextAppointmentDetail;
  Map<String, dynamic>? _healthPoints;

  // Stats-strip data (lifted from individual widgets so the strip can
  // render at the top with the same numbers without each widget
  // duplicating its own fetch).
  int? _wellnessScore;
  int? _stepsToday;
  int? _stepGoal;
  int? _streakDays;

  // Features list
  late final List<FeatureIconData> _features;

  @override
  void initState() {
    super.initState();
    final user = context.read<UserProvider>();
    _phone = user.phone;
    _name = user.name;
    _hospitalNumber = user.hospitalNumber;
    _isGuestSession = user.isGuest;
    _features = _initializeFeatures();
    cachedName = _name;

    _connectivitySub = ConnectivityService.onChange.listen((isOnline) {
      if (isOnline && mounted && !_isGuestSession) {
        _fetchAndStoreDashboard();
      }
    });

    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (!_isGuestSession) {
        _loadCachedData();
        _maybeFetchFromBackend();
        _startAppointmentPolling();
        _startSmartWidgetPolling();
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
    _appointmentPoller?.cancel();
    _smartWidgetPoller?.cancel();
    super.dispose();
  }

  // ── Appointment polling (30s, with backoff on consecutive failures) ──
  void _startAppointmentPolling() {
    _pollAppointments(); // immediate first poll
    _scheduleNextApptPoll();
  }

  void _scheduleNextApptPoll() {
    final backoff = _apptPollFailures > 0
        ? Duration(seconds: 30 * (1 << _apptPollFailures.clamp(0, 4)))
        : const Duration(seconds: 30);
    _appointmentPoller?.cancel();
    _appointmentPoller = Timer(backoff, () {
      _pollAppointments();
      if (mounted) _scheduleNextApptPoll();
    });
  }

  Future<void> _pollAppointments() async {
    if (_isGuestSession) return;
    try {
      final uid = FirebaseAuth.instance.currentUser?.uid;
      if (uid == null || uid.isEmpty) return;

      final response = await ApiClient.get(
        '/appointments/uid/$uid',
        timeout: const Duration(seconds: 8),
      );
      if (!mounted) return;

      if (response.isSuccess) {
        final List<dynamic> appointments = response.data ?? [];

        // Find today's appointment
        final now = DateTime.now();
        final todayStr = DateFormat('yyyy-MM-dd').format(now);

        Map<String, dynamic>? todayAppt;
        for (final appt in appointments) {
          final dateStr = appt['appointment_date']?.toString() ?? '';
          // Check if appointment is today
          if (dateStr.startsWith(todayStr)) {
            final status = appt['status']?.toString() ?? '';
            if (status != 'CANCELLED' && status != 'NO_SHOW') {
              todayAppt = Map<String, dynamic>.from(appt);
              break;
            }
          }
        }

        if (mounted) {
          setState(() {
            _todayAppointment = todayAppt;
            _appointmentStatus = todayAppt?['status']?.toString() ?? '';
          });
        }
      }
      _apptPollFailures = 0; // reset on any successful response
    } catch (e) {
      _apptPollFailures++;
      if (kDebugMode) {
        debugPrint('Appointment poll failed (#$_apptPollFailures): $e');
      }
    }
  }

  String _statusLabel(String status) {
    switch (status.toUpperCase()) {
      case 'SCHEDULED':
      case 'CONFIRMED':
        return 'Waiting';
      case 'IN_PROGRESS':
        return 'In Consultation';
      case 'COMPLETED':
        return 'Completed';
      case 'RESCHEDULED':
        return 'Rescheduled';
      default:
        return status;
    }
  }

  Color _statusColor(String status) {
    switch (status.toUpperCase()) {
      case 'SCHEDULED':
      case 'CONFIRMED':
        return Colors.orange;
      case 'IN_PROGRESS':
        return Colors.blue;
      case 'COMPLETED':
        return Colors.green;
      default:
        return Colors.grey;
    }
  }

  IconData _statusIcon(String status) {
    switch (status.toUpperCase()) {
      case 'SCHEDULED':
      case 'CONFIRMED':
        return LucideIcons.clock;
      case 'IN_PROGRESS':
        return LucideIcons.stethoscope;
      case 'COMPLETED':
        return LucideIcons.checkCircle;
      default:
        return LucideIcons.alertCircle;
    }
  }

  // ── Smart widget polling (60s, with backoff on consecutive failures) ──
  void _startSmartWidgetPolling() {
    _fetchSmartWidgetData(); // immediate first fetch
    _scheduleNextSmartPoll();
  }

  void _scheduleNextSmartPoll() {
    final backoff = _smartPollFailures > 0
        ? Duration(seconds: 60 * (1 << _smartPollFailures.clamp(0, 4)))
        : const Duration(seconds: 60);
    _smartWidgetPoller?.cancel();
    _smartWidgetPoller = Timer(backoff, () {
      _fetchSmartWidgetData();
      if (mounted) _scheduleNextSmartPoll();
    });
  }

  Future<void> _fetchSmartWidgetData() async {
    if (_isGuestSession) return;
    try {
      // 1. Active pharmacy order
      try {
        final pharmaRes = await ApiClient.get(
          '/pharmacy-orders/orders/my',
          timeout: const Duration(seconds: 8),
        );
        if (mounted && pharmaRes.isSuccess) {
          final List<dynamic> orders = pharmaRes.data ?? [];
          Map<String, dynamic>? active;
          for (final o in orders) {
            final status = o['status']?.toString().toUpperCase() ?? '';
            if (status != 'DELIVERED' && status != 'CANCELLED') {
              active = Map<String, dynamic>.from(o);
              break;
            }
          }
          if (mounted) setState(() => _activePharmacyOrder = active);
        }
      } catch (e) {
        if (kDebugMode) debugPrint('Smart poll (pharmacy) failed: $e');
      }

      // 2. Active investigation booking
      try {
        final invRes = await ApiClient.get(
          '/investigations/bookings/my',
          timeout: const Duration(seconds: 8),
        );
        if (mounted && invRes.isSuccess) {
          final List<dynamic> bookings = invRes.data ?? [];
          Map<String, dynamic>? active;
          for (final b in bookings) {
            final status = b['status']?.toString().toUpperCase() ?? '';
            if (status != 'COMPLETED' &&
                status != 'CANCELLED' &&
                status != 'REPORT_READY') {
              active = Map<String, dynamic>.from(b);
              break;
            }
          }
          if (mounted) setState(() => _activeInvestigationBooking = active);
        }
      } catch (e) {
        if (kDebugMode) debugPrint('Smart poll (investigations) failed: $e');
      }

      // 3. Recent prescription (not yet ordered via pharmacy)
      try {
        final rxRes = await ApiClient.get(
          '/prescriptions/patient/my',
          timeout: const Duration(seconds: 8),
        );
        if (mounted && rxRes.isSuccess) {
          final List<dynamic> prescriptions = rxRes.data ?? [];
          Map<String, dynamic>? recent;
          for (final rx in prescriptions) {
            final pharmacyOpted =
                rx['pharmacy_opted'] ?? rx['pharmacyOpted'] ?? false;
            if (pharmacyOpted == false || pharmacyOpted == 'false') {
              recent = Map<String, dynamic>.from(rx);
              break;
            }
          }
          if (mounted) setState(() => _recentPrescription = recent);
        }
      } catch (e) {
        if (kDebugMode) debugPrint('Smart poll (prescriptions) failed: $e');
      }

      // 4. Wellness score (for the stats strip header)
      try {
        final wsRes = await ApiClient.get(
          '/gamification/wellness-score',
          timeout: const Duration(seconds: 8),
        );
        if (mounted && wsRes.isSuccess) {
          final data = wsRes.dataAsMap();
          final score = data['score'];
          if (mounted && score is num) {
            setState(() => _wellnessScore = score.toInt());
          }
        }
      } catch (e) {
        if (kDebugMode) debugPrint('Smart poll (wellness) failed: $e');
      }

      // 5. Steps profile (today + goal for the stats strip)
      try {
        final stepsRes = await ApiClient.get(
          '/steps/profile',
          timeout: const Duration(seconds: 8),
        );
        if (mounted && stepsRes.isSuccess) {
          final data = stepsRes.dataAsMap();
          final today =
              data['steps_today'] ?? data['stepsToday'] ?? data['today'];
          final goal = data['daily_goal'] ?? data['dailyGoal'] ?? data['goal'];
          final streak =
              data['streak_days'] ?? data['streakDays'] ?? data['streak'];
          if (mounted) {
            setState(() {
              _stepsToday = today is num ? today.toInt() : _stepsToday;
              _stepGoal = goal is num ? goal.toInt() : _stepGoal;
              _streakDays = streak is num ? streak.toInt() : _streakDays;
            });
          }
        }
      } catch (e) {
        if (kDebugMode) debugPrint('Smart poll (steps) failed: $e');
      }

      _smartPollFailures = 0; // reset on any partial success
    } catch (e) {
      _smartPollFailures++;
      if (kDebugMode) {
        debugPrint('Smart poll failed (#$_smartPollFailures): $e');
      }
    }
  }

  // ── Existing methods (unchanged) ───────────────────────────────

  List<FeatureIconData> _initializeFeatures() {
    return [
      FeatureIconData(
        icon: LucideIcons.stethoscope,
        svgAsset: 'assets/images/features/your-health.svg',
        label: 'Your Health',
        color: const Color(0xFFA8E6CF),
        onTap: (ctx) => _openFeature(ctx, '/your-health'),
      ),
      FeatureIconData(
        icon: LucideIcons.calendarCheck,
        svgAsset: 'assets/images/features/appointments.svg',
        label: 'Appointments',
        color: const Color(0xFFB3E5FC),
        onTap: (ctx) => _openFeature(ctx, '/appointments'),
      ),
      FeatureIconData(
        icon: LucideIcons.folderOpen,
        svgAsset: 'assets/images/features/records.svg',
        label: 'Records',
        color: const Color(0xFFB2DFDB),
        onTap: (ctx) => _openFeature(ctx, '/records'),
      ),
      FeatureIconData(
        icon: LucideIcons.pill,
        svgAsset: 'assets/images/features/pharmacy.svg',
        label: 'Pharmacy',
        color: const Color(0xFFD1C4E9),
        onTap: (ctx) => _openFeature(ctx, '/pharmacy'),
      ),
      FeatureIconData(
        icon: LucideIcons.flaskConical,
        svgAsset: 'assets/images/features/investigations.svg',
        label: 'Investigations',
        color: const Color(0xFF80DEEA),
        onTap: (ctx) => _openFeature(ctx, '/investigations'),
      ),
      FeatureIconData(
        icon: LucideIcons.helpCircle,
        svgAsset: 'assets/images/features/ask-a-doubt.svg',
        label: 'Ask a Doubt',
        color: const Color(0xFFFFE082),
        onTap: (ctx) => _openFeature(ctx, '/ask-a-doubt'),
      ),
      FeatureIconData(
        icon: LucideIcons.brainCircuit,
        svgAsset: 'assets/images/features/trivia.svg',
        label: 'Trivia',
        color: const Color(0xFF9FA8DA),
        onTap: (ctx) => _openFeature(ctx, '/trivia'),
      ),
      FeatureIconData(
        icon: LucideIcons.building2,
        svgAsset: 'assets/images/features/departments.svg',
        label: 'Departments',
        color: const Color(0xFFC5E1A5),
        onTap: (ctx) => _openFeature(ctx, '/departments'),
      ),
      FeatureIconData(
        icon: LucideIcons.info,
        svgAsset: 'assets/images/features/about-us.svg',
        label: 'About Us',
        color: const Color(0xFFFFCCBC),
        onTap: (ctx) => _openFeature(ctx, '/about-us'),
      ),
      FeatureIconData(
        icon: LucideIcons.footprints,
        svgAsset: 'assets/images/features/step-challenge.svg',
        label: 'Step Challenge',
        color: const Color(0xFFA5D6A7),
        onTap: (ctx) => _openFeature(ctx, '/steps'),
      ),
      FeatureIconData(
        icon: LucideIcons.heartPulse,
        svgAsset: 'assets/images/features/vitals.svg',
        label: 'Vitals',
        color: const Color(0xFFEF9A9A),
        description:
            'Log and track daily vitals like blood pressure, heart rate, and SpO2',
        onTap: (ctx) => _openFeature(ctx, '/vitals'),
      ),
      FeatureIconData(
        icon: LucideIcons.refreshCw,
        svgAsset: 'assets/images/features/refills.svg',
        label: 'Refills',
        color: const Color(0xFF81D4FA),
        description:
            'Request prescription refills from your active medications',
        onTap: (ctx) => _openFeature(ctx, '/refill'),
      ),
      FeatureIconData(
        icon: LucideIcons.users,
        svgAsset: 'assets/images/features/family.svg',
        label: 'Family',
        color: const Color(0xFFCE93D8),
        description: 'Manage family members linked to your account',
        onTap: (ctx) => _openFeature(ctx, '/family'),
      ),
      FeatureIconData(
        icon: Icons.emoji_events,
        svgAsset: 'assets/images/features/health-points.svg',
        label: 'Health Points',
        color: const Color(0xFFFFD54F),
        onTap: (ctx) => _openFeature(ctx, '/health-points'),
      ),
      FeatureIconData(
        icon: Icons.pregnant_woman,
        label: 'Maternity',
        color: const Color(0xFFF8BBD0),
        description: 'Track ANC visits, kick counts, advice, and packages',
        onTap: (ctx) => _openFeature(ctx, '/portal/maternity/timeline'),
      ),
      // Patient self-service portal — Sprint 10. SVG assets not yet
      // designed; falls back to the Lucide icon glyph.
      FeatureIconData(
        icon: LucideIcons.receipt,
        label: 'Bills',
        color: const Color(0xFFB3E5FC),
        description: 'View hospital bills, see what is due, and pay via UPI',
        onTap: (ctx) => _openFeature(ctx, '/portal/bills'),
      ),
      FeatureIconData(
        icon: LucideIcons.testTube,
        label: 'Lab Results',
        color: const Color(0xFF80DEEA),
        description: 'View signed-off lab results with reference ranges',
        onTap: (ctx) => _openFeature(ctx, '/portal/lab-results'),
      ),
      FeatureIconData(
        icon: LucideIcons.shieldCheck,
        label: 'Insurance Claims',
        color: const Color(0xFFB2DFDB),
        description:
            'View TPA/cashless claim status, amounts, and disallowance reasons',
        onTap: (ctx) => _openFeature(ctx, '/portal/tpa/claims'),
      ),
      FeatureIconData(
        icon: LucideIcons.messageSquare,
        label: 'Messages',
        color: const Color(0xFFFFE082),
        description: 'Secure messages with your hospital care team',
        onTap: (ctx) => _openFeature(ctx, '/portal/messages'),
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
      final fetched = await _secureStorage.read(key: 'fetched_dashboard');
      if (!mounted || fetched == 'true') return;
      await Future.delayed(const Duration(seconds: 1));
      if (mounted) _fetchAndStoreDashboard();
    } catch (e) {
      debugPrint('Dashboard error: $e');
    }
  }

  Future<void> _fetchAndStoreDashboard() async {
    if (_isGuestSession) return;
    try {
      final result = await ApiClient.cachedGet(
        '/dashboard',
        queryParameters: {'phone': _phone},
        timeout: const Duration(seconds: 10),
      );
      if (!mounted) return;

      if (result.isSuccess) {
        final data = result.data ?? {};
        final name = data['name'] ?? _name;
        final last = data['lastAppointment'];
        final next = data['nextAppointment'];
        final nextDetail =
            data['nextAppointmentDetail'] as Map<String, dynamic>?;
        final healthPts = data['healthPoints'] as Map<String, dynamic>?;

        setState(() {
          _staleLabel = result.staleLabel;
          cachedName = name;
          lastAppointment = last;
          nextAppointment = next;
          _nextAppointmentDetail = nextDetail;
          _healthPoints = healthPts;
        });

        // Persist to secure storage
        await Future.wait([
          _secureStorage.write(key: 'userName', value: name),
          _secureStorage.write(key: 'lastAppointment', value: last),
          _secureStorage.write(key: 'nextAppointment', value: next),
          _secureStorage.write(key: 'fetched_dashboard', value: 'true'),
        ]);

        // Listen for fresh network data if cache was served first
        result.onFresh?.then((fresh) {
          if (!mounted) return;
          if (fresh.isSuccess) {
            final freshData = fresh.data ?? {};
            final freshName = freshData['name'] ?? _name;
            final freshLast = freshData['lastAppointment'];
            final freshNext = freshData['nextAppointment'];
            final nextDetail =
                freshData['nextAppointmentDetail'] as Map<String, dynamic>?;
            final healthPts =
                freshData['healthPoints'] as Map<String, dynamic>?;
            setState(() {
              _staleLabel = null;
              cachedName = freshName;
              lastAppointment = freshLast;
              nextAppointment = freshNext;
              _nextAppointmentDetail = nextDetail;
              _healthPoints = healthPts;
            });
          }
        });
      }
    } catch (e) {
      debugPrint('Dashboard error: $e');
    }
  }

  void _openFeature(BuildContext context, String routeName) {
    final publicGuestRoutes = {'/about-us', '/departments', '/trivia'};
    if (_isGuestSession && !publicGuestRoutes.contains(routeName)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Please sign in to use this feature.'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      context.push('/login');
      return;
    }

    if (routeName == '/your-health') {
      context.push('/health');
    } else if (routeName == '/records') {
      // Records merged into Your Health — open Hospital Docs tab (index 1)
      context.push('/health', extra: {'tab': 1});
    } else {
      context.push(routeName);
    }
  }

  Future<void> _triggerSOS() async {
    final l10n = AppLocalizations.of(context)!;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(l10n.authSosTriggered)));
    await SOSService.triggerSOS();
  }

  /// Pull-to-refresh handler. Re-runs the dashboard fetch + the smart
  /// widget poll + the appointment poll in parallel. Returns when all
  /// three settle so the RefreshIndicator spinner stays up exactly long
  /// enough to feel intentional.
  Future<void> _refreshAll() async {
    if (_isGuestSession) return;
    await Future.wait([
      _fetchAndStoreDashboard(),
      _fetchSmartWidgetData(),
      _pollAppointments(),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final nameToShow = cachedName ?? _name;
    final isGuest = context.watch<UserProvider>().isGuest;
    final unread = !isGuest
        ? context.watch<NotificationProvider>().unreadCount
        : 0;

    final hasUpdates =
        !isGuest &&
        (_nextAppointmentDetail != null ||
            _healthPoints != null ||
            _activePharmacyOrder != null ||
            _activeInvestigationBooking != null ||
            _recentPrescription != null);

    final hasTodaySection = !isGuest && _todayAppointment != null;
    // Only render the Wellness section once we have at least one signal,
    // otherwise the tinted card would show an empty body (the inner
    // widgets self-hide on no-data and the section header would orphan).
    final hasWellnessSection = !isGuest && _wellnessScore != null;
    final hasStatsSection = !isGuest;
    final hasQuickActionsSection = !isGuest;
    final hasAppointmentsSection =
        !isGuest && (lastAppointment != null || nextAppointment != null);

    // Build the snapshot row labels.
    final nextApptLabel = _formatNextApptLabel();
    final lastVitalsLabel = _formatLastVitalsLabel();

    // Per-feature badges for the FeatureGrid. Only the categories that
    // currently have user-relevant state get a badge.
    final featureBadges = <String, String>{
      if (_activePharmacyOrder != null) 'Pharmacy': '1 active',
      if (_activeInvestigationBooking != null) 'Investigations': '1 active',
      if (_recentPrescription != null) 'Your Health': 'New rx',
      if (_todayAppointment != null) 'Appointments': 'Today',
    };

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
              ),

              // Profile switcher (guardian → minor dependents). Self-hides
              // when the user has no linked dependents.
              if (!isGuest) const ProfileSwitcher(),

              // Offline / stale-data banner (pinned, stays visible on scroll).
              OfflineBanner(staleLabel: _staleLabel),

              Expanded(
                child: RefreshIndicator(
                  onRefresh: _refreshAll,
                  child: SingleChildScrollView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.only(bottom: 32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        // ── At a glance (stats strip) ────────────────────
                        if (hasStatsSection)
                          stagger(
                            StatsStrip(
                              wellnessScore: _wellnessScore,
                              healthPoints: _healthPoints?['totalPoints'] is num
                                  ? (_healthPoints!['totalPoints'] as num)
                                        .toInt()
                                  : null,
                              healthTier: _healthPoints?['currentTier']
                                  ?.toString(),
                              stepsToday: _stepsToday,
                              stepGoal: _stepGoal,
                              streakDays: _streakDays,
                              onWellnessTap: () =>
                                  _openFeature(context, '/health-points'),
                              onPointsTap: () =>
                                  _openFeature(context, '/health-points'),
                              onStepsTap: () => _openFeature(context, '/steps'),
                            ),
                          ),

                        // ── Today ────────────────────────────────────────
                        if (hasTodaySection)
                          stagger(
                            DashboardSection(
                              label: 'Today',
                              accent: DashboardAccents.today,
                              tinted: false,
                              child: TodayAppointmentCard(
                                appointment: _todayAppointment!,
                                statusLabel: _statusLabel(_appointmentStatus),
                                statusColor: _statusColor(_appointmentStatus),
                                statusIcon: _statusIcon(_appointmentStatus),
                              ),
                            ),
                          ),

                        // ── Wellness (score ring + insights) ─────────────
                        // Children self-hide on no-data; render the section
                        // wrapper anyway so the user sees the heading
                        // (with a subtle "Loading…" feel via empty card).
                        if (hasWellnessSection)
                          stagger(
                            DashboardSection(
                              label: 'Wellness',
                              accent: DashboardAccents.wellness,
                              contentPadding: const EdgeInsets.fromLTRB(
                                4,
                                4,
                                4,
                                4,
                              ),
                              child: const Column(
                                children: [
                                  WellnessScoreWidget(),
                                  HealthInsightsStrip(),
                                ],
                              ),
                            ),
                          ),

                        // ── Updates (gamification + smart contextual) ────
                        if (hasUpdates)
                          stagger(
                            DashboardSection(
                              label: 'Updates',
                              accent: DashboardAccents.updates,
                              contentPadding: const EdgeInsets.fromLTRB(
                                4,
                                4,
                                4,
                                4,
                              ),
                              child: Column(
                                children: [
                                  if (_nextAppointmentDetail != null)
                                    NextVisitProgressWidget(
                                      detail: _nextAppointmentDetail,
                                      onTap: () => _openFeature(
                                        context,
                                        '/appointments',
                                      ),
                                      onSchedule: () => _openFeature(
                                        context,
                                        '/appointments',
                                      ),
                                    ),
                                  if (_healthPoints != null)
                                    HealthPointsWidget(
                                      data: _healthPoints,
                                      onTap: () => _openFeature(
                                        context,
                                        '/health-points',
                                      ),
                                    ),
                                  if (_activePharmacyOrder != null)
                                    SmartPharmacyCard(
                                      order: _activePharmacyOrder!,
                                      onTap: () =>
                                          _openFeature(context, '/pharmacy'),
                                    ),
                                  if (_activeInvestigationBooking != null)
                                    SmartInvestigationCard(
                                      booking: _activeInvestigationBooking!,
                                      onTap: () => _openFeature(
                                        context,
                                        '/investigations',
                                      ),
                                    ),
                                  if (_recentPrescription != null)
                                    SmartPrescriptionCard(
                                      prescription: _recentPrescription!,
                                      onOrderTap: () =>
                                          _openFeature(context, '/pharmacy'),
                                      onViewTap: () =>
                                          _openFeature(context, '/records'),
                                    ),
                                ],
                              ),
                            ),
                          ),

                        // ── Quick actions ────────────────────────────────
                        if (hasQuickActionsSection)
                          stagger(
                            DashboardSection(
                              label: 'Quick actions',
                              accent: DashboardAccents.quickActions,
                              tinted: false,
                              child: Padding(
                                padding: const EdgeInsets.fromLTRB(0, 0, 0, 4),
                                child: Row(
                                  mainAxisAlignment:
                                      MainAxisAlignment.spaceEvenly,
                                  children: [
                                    QuickActionButton(
                                      icon: LucideIcons.calendarPlus,
                                      label: 'Book',
                                      color: DashboardAccents.appointments,
                                      onTap: () => _openFeature(
                                        context,
                                        '/appointments',
                                      ),
                                    ),
                                    QuickActionButton(
                                      icon: LucideIcons.fileText,
                                      label: 'Records',
                                      color: DashboardAccents.wellness,
                                      onTap: () =>
                                          _openFeature(context, '/records'),
                                    ),
                                    QuickActionButton(
                                      icon: LucideIcons.pill,
                                      label: 'Pharmacy',
                                      color: DashboardAccents.updates,
                                      onTap: () =>
                                          _openFeature(context, '/pharmacy'),
                                    ),
                                    QuickActionButton(
                                      icon: Icons.favorite,
                                      label: 'SOS',
                                      color: Colors.red,
                                      onTap: _triggerSOS,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),

                        // ── Explore (feature grid replaces the dial) ─────
                        stagger(
                          DashboardSection(
                            label: 'Explore',
                            accent: DashboardAccents.explore,
                            tinted: false,
                            child: FeatureGrid(
                              features: _features,
                              badges: featureBadges,
                            ),
                          ),
                        ),

                        // ── Appointments summary ─────────────────────────
                        if (hasAppointmentsSection)
                          stagger(
                            DashboardSection(
                              label: 'Appointments',
                              accent: DashboardAccents.appointments,
                              tinted: false,
                              child: AppointmentCard(
                                lastAppointment: lastAppointment,
                                nextAppointment: nextAppointment,
                                onViewHistory: () =>
                                    _openFeature(context, '/appointments'),
                                onScheduleNew: () =>
                                    _openFeature(context, '/appointments'),
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
      floatingActionButton: FloatingActionButton(
        heroTag: 'sos',
        tooltip: l10n.authSosTooltip,
        backgroundColor: Colors.red,
        onPressed: _triggerSOS,
        child: const Icon(Icons.favorite),
      ),
    );
  }

  /// Builds the "Next visit" snapshot label shown in the header. Falls
  /// back through the available data sources: today's appointment first,
  /// then the upcoming-appointment detail, then the legacy string from
  /// the dashboard endpoint (which arrives as an ISO timestamp; we
  /// reformat to "in N days" for readability).
  String? _formatNextApptLabel() {
    if (_todayAppointment != null) return 'Visit today';
    final detail = _nextAppointmentDetail;
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
    if (_wellnessScore == null) return null;
    return 'Wellness $_wellnessScore/100';
  }
}
