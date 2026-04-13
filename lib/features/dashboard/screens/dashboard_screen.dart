import 'package:go_router/go_router.dart';
import 'package:vhhealth/core/navigation/app_router.dart';

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:provider/provider.dart';
import 'package:lucide_icons/lucide_icons.dart';
import 'package:intl/intl.dart';
import 'package:firebase_auth/firebase_auth.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/services/connectivity_service.dart';
import 'package:vhhealth/core/widgets/language_dropdown.dart';
import 'package:vhhealth/core/widgets/offline_banner.dart';
import 'package:vhhealth/core/widgets/logo_background.dart';
import 'package:vhhealth/core/widgets/circular_feature_dial.dart';
import 'package:vhhealth/core/providers/theme_provider.dart';
import 'package:vhhealth/core/services/sos_service.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth/core/widgets/logout_button.dart';
import 'package:vhhealth/core/theme/theme_colors.dart';
import 'package:vhhealth/features/dashboard/widgets/next_visit_progress_widget.dart';
import 'package:vhhealth/features/dashboard/widgets/health_points_widget.dart';
import 'package:vhhealth/features/dashboard/widgets/wellness_score_widget.dart';
import 'package:vhhealth/features/dashboard/widgets/health_insight_card.dart';
import 'package:vhhealth/features/dashboard/widgets/daily_checkin_sheet.dart';
import 'package:vhhealth/features/dashboard/widgets/quick_action_button.dart';
import 'package:vhhealth/features/dashboard/widgets/today_appointment_card.dart';
import 'package:vhhealth/features/dashboard/widgets/language_menu_button.dart';
import 'package:vhhealth/features/dashboard/widgets/appointment_card.dart';
import 'package:vhhealth/features/dashboard/widgets/smart_pharmacy_card.dart';
import 'package:vhhealth/features/dashboard/widgets/smart_investigation_card.dart';
import 'package:vhhealth/features/dashboard/widgets/smart_prescription_card.dart';

class DashboardScreen extends StatefulWidget {
  final String name;
  final String phone;
  final String? lastAppointment;
  final String? nextAppointment;

  const DashboardScreen({
    super.key,
    required this.name,
    required this.phone,
    this.lastAppointment,
    this.nextAppointment,
  });

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final _secureStorage = const FlutterSecureStorage();
  String? lastAppointment;
  String? nextAppointment;
  String? cachedName;
  // ignore: unused_field
  Color _focusColor = Colors.blue;
  
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

  // Features list
  late final List<FeatureIconData> _features;

  @override
  void initState() {
    super.initState();
    _features = _initializeFeatures();
    lastAppointment = widget.lastAppointment;
    nextAppointment = widget.nextAppointment;
    cachedName = widget.name;

    _connectivitySub = ConnectivityService.onChange.listen((isOnline) {
      if (isOnline && mounted) {
        _fetchAndStoreDashboard();
      }
    });

    SchedulerBinding.instance.addPostFrameCallback((_) {
      _loadCachedData();
      _maybeFetchFromBackend();
      _startAppointmentPolling();
      _startSmartWidgetPolling();
      // Daily mood check-in prompt — only shows if not already done today.
      if (mounted && cachedName != 'Guest') {
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
      if (kDebugMode) debugPrint('Appointment poll failed (#$_apptPollFailures): $e');
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
            if (status != 'COMPLETED' && status != 'CANCELLED' && status != 'REPORT_READY') {
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
            final pharmacyOpted = rx['pharmacy_opted'] ?? rx['pharmacyOpted'] ?? false;
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
      _smartPollFailures = 0; // reset on any partial success
    } catch (e) {
      _smartPollFailures++;
      if (kDebugMode) debugPrint('Smart poll failed (#$_smartPollFailures): $e');
    }
  }

  // ── Existing methods (unchanged) ───────────────────────────────

  List<FeatureIconData> _initializeFeatures() {
    return [
      FeatureIconData(
        icon: LucideIcons.stethoscope,
        label: 'Your Health',
        color: const Color(0xFFA8E6CF),
        onTap: (ctx) => _openFeature(ctx, '/your-health'),
      ),
      FeatureIconData(
        icon: LucideIcons.calendarCheck,
        label: 'Appointments',
        color: const Color(0xFFB3E5FC),
        onTap: (ctx) => _openFeature(ctx, '/appointments'),
      ),
      FeatureIconData(
        icon: LucideIcons.folderOpen,
        label: 'Records',
        color: const Color(0xFFB2DFDB),
        onTap: (ctx) => _openFeature(ctx, '/records'),
      ),
      FeatureIconData(
        icon: LucideIcons.pill,
        label: 'Pharmacy',
        color: const Color(0xFFD1C4E9),
        onTap: (ctx) => _openFeature(ctx, '/pharmacy'),
      ),
      FeatureIconData(
        icon: LucideIcons.flaskConical,
        label: 'Investigations',
        color: const Color(0xFF80DEEA),
        onTap: (ctx) => _openFeature(ctx, '/investigations'),
      ),
      FeatureIconData(
        icon: LucideIcons.helpCircle,
        label: 'Ask a Doubt',
        color: const Color(0xFFFFE082),
        onTap: (ctx) => _openFeature(ctx, '/ask-a-doubt'),
      ),
      FeatureIconData(
        icon: LucideIcons.brainCircuit,
        label: 'Trivia',
        color: const Color(0xFF9FA8DA),
        onTap: (ctx) => _openFeature(ctx, '/trivia'),
      ),
      FeatureIconData(
        icon: LucideIcons.building2,
        label: 'Departments',
        color: const Color(0xFFC5E1A5),
        onTap: (ctx) => _openFeature(ctx, '/departments'),
      ),
      FeatureIconData(
        icon: LucideIcons.info,
        label: 'About Us',
        color: const Color(0xFFFFCCBC),
        onTap: (ctx) => _openFeature(ctx, '/about-us'),
      ),
      FeatureIconData(
        icon: LucideIcons.footprints,
        label: 'Step Challenge',
        color: const Color(0xFFA5D6A7),
        onTap: (ctx) => _openFeature(ctx, '/steps'),
      ),
      FeatureIconData(
        icon: LucideIcons.heartPulse,
        label: 'Vitals',
        color: const Color(0xFFEF9A9A),
        description: 'Log and track daily vitals like blood pressure, heart rate, and SpO2',
        onTap: (ctx) => _openFeature(ctx, '/vitals'),
      ),
      FeatureIconData(
        icon: LucideIcons.refreshCw,
        label: 'Refills',
        color: const Color(0xFF81D4FA),
        description: 'Request prescription refills from your active medications',
        onTap: (ctx) => _openFeature(ctx, '/refill'),
      ),
      FeatureIconData(
        icon: LucideIcons.users,
        label: 'Family',
        color: const Color(0xFFCE93D8),
        description: 'Manage family members linked to your account',
        onTap: (ctx) => _openFeature(ctx, '/family'),
      ),
      FeatureIconData(
        icon: Icons.emoji_events,
        label: 'Health Points',
        color: const Color(0xFFFFD54F),
        onTap: (ctx) => _openFeature(ctx, '/health-points'),
      ),
    ];
  }

  Future<void> _loadCachedData() async {
    try {
      final results = await Future.wait([
        _secureStorage.read(key: 'lastAppointment'),
        _secureStorage.read(key: 'nextAppointment'),
        _secureStorage.read(key: 'userName'),
      ]);
      if (mounted) {
        setState(() {
          lastAppointment = results[0] ?? widget.lastAppointment;
          nextAppointment = results[1] ?? widget.nextAppointment;
          cachedName = results[2] ?? widget.name;
        });
      }
    } catch (e) { debugPrint('Dashboard error: $e'); }
  }

  Future<void> _maybeFetchFromBackend() async {
    try {
      final fetched = await _secureStorage.read(key: 'fetched_dashboard');
      if (!mounted || fetched == 'true') return;
      await Future.delayed(const Duration(seconds: 1));
      if (mounted) _fetchAndStoreDashboard();
    } catch (e) { debugPrint('Dashboard error: $e'); }
  }

  Future<void> _fetchAndStoreDashboard() async {
    try {
      final result = await ApiClient.cachedGet(
        '/dashboard',
        queryParameters: {'phone': widget.phone},
        timeout: const Duration(seconds: 10),
      );
      if (!mounted) return;

      if (result.isSuccess) {
        final data = result.data ?? {};
        final name = data['name'] ?? widget.name;
        final last = data['lastAppointment'];
        final next = data['nextAppointment'];
        final nextDetail = data['nextAppointmentDetail'] as Map<String, dynamic>?;
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
            final freshName = freshData['name'] ?? widget.name;
            final freshLast = freshData['lastAppointment'];
            final freshNext = freshData['nextAppointment'];
            final nextDetail = freshData['nextAppointmentDetail'] as Map<String, dynamic>?;
            final healthPts = freshData['healthPoints'] as Map<String, dynamic>?;
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
    } catch (e) { debugPrint('Dashboard error: $e'); }
  }

  void _openFeature(BuildContext context, String routeName) {
    if (routeName == '/departments') {
      AppRouter.setUserData(widget.phone, cachedName ?? widget.name);
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

  void _toggleTheme() =>
      Provider.of<ThemeProvider>(context, listen: false).toggleTheme();

  void _toggleAccessibility() =>
      Provider.of<ThemeProvider>(context, listen: false).toggleFontSize();

  Future<void> _triggerSOS() async {
    final l10n = AppLocalizations.of(context)!;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(l10n.authSosTriggered)),
    );
    await SOSService.triggerSOS();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final nameToShow = cachedName ?? widget.name;
    final screenHeight = MediaQuery.of(context).size.height;
    final isGuest = nameToShow == 'Guest';

    return Scaffold(
      appBar: AppBar(
        title: Text('Hello, ${nameToShow == 'Guest' ? nameToShow : '$nameToShow!'}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.brightness_6),
            onPressed: _toggleTheme,
          ),
          IconButton(
            icon: const Icon(Icons.accessibility),
            onPressed: _toggleAccessibility,
          ),
          const LanguageMenuButton(),
          const LogoutButton(style: LogoutButtonStyle.iconOnly),
        ],
      ),
      body: LogoBackground(
        child: SafeArea(
          child: Column(
            children: [
              // Offline / stale-data banner (pinned at top, stays visible while scrolling)
              OfflineBanner(staleLabel: _staleLabel),

              // Scrollable region — wellness/insights/gamification/smart cards stacking
              // above the dial used to compress the dial via Expanded(flex: 3).
              // Scrolling + a fixed-height dial keeps every widget fully visible.
              Expanded(
                child: SingleChildScrollView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
              // Today's appointment status card (real-time)
              if (_todayAppointment != null && !isGuest)
                TodayAppointmentCard(
                  appointment: _todayAppointment!,
                  statusLabel: _statusLabel(_appointmentStatus),
                  statusColor: _statusColor(_appointmentStatus),
                  statusIcon: _statusIcon(_appointmentStatus),
                ),

              // Personal Wellness Score (animated 0-100 ring)
              if (!isGuest) const WellnessScoreWidget(),

              // Smart Health Insights (up to 2 cards)
              if (!isGuest) const HealthInsightsStrip(),

              // Gamification widgets
              if (!isGuest && _nextAppointmentDetail != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: NextVisitProgressWidget(
                    detail: _nextAppointmentDetail,
                    onTap: () => _openFeature(context, '/appointments'),
                    onSchedule: () => _openFeature(context, '/appointments'),
                  ),
                ),
              if (!isGuest && _healthPoints != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: HealthPointsWidget(
                    data: _healthPoints,
                    onTap: () => _openFeature(context, '/health-points'),
                  ),
                ),

              // Smart contextual widgets
              if (!isGuest) ...[
                if (_activePharmacyOrder != null)
                  SmartPharmacyCard(
                    order: _activePharmacyOrder!,
                    onTap: () => _openFeature(context, '/pharmacy'),
                  ),
                if (_activeInvestigationBooking != null)
                  SmartInvestigationCard(
                    booking: _activeInvestigationBooking!,
                    onTap: () => _openFeature(context, '/investigations'),
                  ),
                if (_recentPrescription != null)
                  SmartPrescriptionCard(
                    prescription: _recentPrescription!,
                    onOrderTap: () => _openFeature(context, '/pharmacy'),
                    onViewTap: () => _openFeature(context, '/records'),
                  ),
              ],

              // Quick action buttons
              if (!isGuest)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: Row(
                    children: [
                      QuickActionButton(
                        icon: LucideIcons.calendarPlus,
                        label: 'Book',
                        color: cs.primary,
                        onTap: () => _openFeature(context, '/appointments'),
                      ),
                      QuickActionButton(
                        icon: LucideIcons.fileText,
                        label: 'Records',
                        color: cs.tertiary,
                        onTap: () => _openFeature(context, '/records'),
                      ),
                      QuickActionButton(
                        icon: LucideIcons.pill,
                        label: 'Pharmacy',
                        color: cs.secondary,
                        onTap: () => _openFeature(context, '/pharmacy'),
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

              // Feature dial — fixed height so it never compresses as
              // above-dial widgets stack up.
              SizedBox(
                height: screenHeight * 0.42,
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: CircularFeatureDial(
                    features: _features,
                    size: MediaQuery.of(context).size.width * 0.75,
                    onFocusColorChanged: (color) {
                      setState(() => _focusColor = color);
                    },
                  ),
                ),
              ),

              // Appointment card
              if (!isGuest)
                AppointmentCard(
                  lastAppointment: lastAppointment,
                  nextAppointment: nextAppointment,
                  onViewHistory: () => _openFeature(context, '/appointments'),
                  onScheduleNew: () => _openFeature(context, '/appointments'),
                ),
                    ],
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
}

