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

        setState(() {
          _staleLabel = result.staleLabel;
          cachedName = name;
          lastAppointment = last;
          nextAppointment = next;
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
            setState(() {
              _staleLabel = null;
              cachedName = freshName;
              lastAppointment = freshLast;
              nextAppointment = freshNext;
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
          const _LanguageMenuButton(),
          const LogoutButton(style: LogoutButtonStyle.iconOnly),
        ],
      ),
      body: LogoBackground(
        child: SafeArea(
          child: Column(
            children: [
              // Offline / stale-data banner
              OfflineBanner(staleLabel: _staleLabel),

              // Today's appointment status card (real-time)
              if (_todayAppointment != null && !isGuest)
                _TodayAppointmentCard(
                  appointment: _todayAppointment!,
                  statusLabel: _statusLabel(_appointmentStatus),
                  statusColor: _statusColor(_appointmentStatus),
                  statusIcon: _statusIcon(_appointmentStatus),
                ),

              // Smart contextual widgets
              if (!isGuest) ...[
                if (_activePharmacyOrder != null)
                  _SmartPharmacyCard(
                    order: _activePharmacyOrder!,
                    onTap: () => _openFeature(context, '/pharmacy'),
                  ),
                if (_activeInvestigationBooking != null)
                  _SmartInvestigationCard(
                    booking: _activeInvestigationBooking!,
                    onTap: () => _openFeature(context, '/investigations'),
                  ),
                if (_recentPrescription != null)
                  _SmartPrescriptionCard(
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
                      _QuickActionButton(
                        icon: LucideIcons.calendarPlus,
                        label: 'Book',
                        color: cs.primary,
                        onTap: () => _openFeature(context, '/appointments'),
                      ),
                      _QuickActionButton(
                        icon: LucideIcons.fileText,
                        label: 'Records',
                        color: cs.tertiary,
                        onTap: () => _openFeature(context, '/records'),
                      ),
                      _QuickActionButton(
                        icon: LucideIcons.pill,
                        label: 'Pharmacy',
                        color: cs.secondary,
                        onTap: () => _openFeature(context, '/pharmacy'),
                      ),
                      _QuickActionButton(
                        icon: Icons.favorite,
                        label: 'SOS',
                        color: Colors.red,
                        onTap: _triggerSOS,
                      ),
                    ],
                  ),
                ),

              // Feature dial
              Expanded(
                flex: 3,
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
                Container(
                  constraints: BoxConstraints(
                    minHeight: 120,
                    maxHeight: screenHeight * 0.25,
                  ),
                  child: _AppointmentCard(
                    lastAppointment: lastAppointment,
                    nextAppointment: nextAppointment,
                    onViewHistory: () => _openFeature(context, '/appointments'),
                    onScheduleNew: () => _openFeature(context, '/appointments'),
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

// ── Quick Action Button ──────────────────────────────────────────
class _QuickActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  const _QuickActionButton({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.15),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, color: color, size: 22),
              ),
              const SizedBox(height: 4),
              Text(
                label,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  fontWeight: FontWeight.w600,
                  fontSize: 11,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Today's Appointment Status Card (real-time) ──────────────────
class _TodayAppointmentCard extends StatelessWidget {
  final Map<String, dynamic> appointment;
  final String statusLabel;
  final Color statusColor;
  final IconData statusIcon;

  const _TodayAppointmentCard({
    required this.appointment,
    required this.statusLabel,
    required this.statusColor,
    required this.statusIcon,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final doctorName = appointment['doctor_name']?.toString() ?? 'Doctor';
    final time = appointment['appointment_time']?.toString() ?? '';

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: statusColor.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: statusColor.withValues(alpha: 0.3)),
      ),
      child: Row(
        children: [
          Icon(statusIcon, color: statusColor, size: 28),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: statusColor,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        'TODAY',
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 10,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      statusLabel,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: statusColor,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  'Dr. $doctorName${time.isNotEmpty ? ' • $time' : ''}',
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Language Menu Button ─────────────────────────────────────────
class _LanguageMenuButton extends StatelessWidget {
  const _LanguageMenuButton();

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<int>(
      tooltip: 'Change Language',
      offset: const Offset(0, 40),
      icon: const Icon(Icons.language),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      itemBuilder: (_) => [
        const PopupMenuItem<int>(
          value: 0,
          enabled: false,
          padding: EdgeInsets.zero,
          child: SizedBox(width: 150, child: LanguageDropdown()),
        ),
      ],
    );
  }
}

// ── Appointment Card ─────────────────────────────────────────────
class _AppointmentCard extends StatelessWidget {
  final String? lastAppointment;
  final String? nextAppointment;
  final VoidCallback? onViewHistory;
  final VoidCallback? onScheduleNew;

  const _AppointmentCard({
    this.lastAppointment,
    this.nextAppointment,
    this.onViewHistory,
    this.onScheduleNew,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      margin: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: theme.colorScheme.primary.withValues(alpha: 0.1),
            blurRadius: 20,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withValues(alpha: 0.1),
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Row(
              children: [
                Icon(LucideIcons.calendar, color: theme.colorScheme.primary, size: 20),
                const SizedBox(width: 8),
                Text(
                  'Appointments',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: _buildAppointmentInfo(
                    context,
                    icon: LucideIcons.checkCircle,
                    iconColor: ThemeColors.getSuccessColor(context),
                    label: 'Last Visit',
                    date: lastAppointment,
                    isPast: true,
                  ),
                ),
                Container(
                  height: 50,
                  width: 1,
                  color: theme.colorScheme.outline.withValues(alpha: 0.2),
                  margin: const EdgeInsets.symmetric(horizontal: 16),
                ),
                Expanded(
                  child: _buildAppointmentInfo(
                    context,
                    icon: LucideIcons.clock,
                    iconColor: ThemeColors.getInfoColor(context),
                    label: 'Next Visit',
                    date: nextAppointment,
                    isPast: false,
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(
                  color: theme.colorScheme.outline.withValues(alpha: 0.2),
                ),
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: TextButton.icon(
                    onPressed: onViewHistory,
                    icon: const Icon(LucideIcons.history, size: 16),
                    label: const Text('History'),
                    style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 8)),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: onScheduleNew,
                    icon: const Icon(LucideIcons.plus, size: 16),
                    label: const Text('Schedule'),
                    style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 8)),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAppointmentInfo(
    BuildContext context, {
    required IconData icon,
    required Color iconColor,
    required String label,
    required String? date,
    required bool isPast,
  }) {
    final theme = Theme.of(context);
    final hasDate = date != null && date.isNotEmpty && date != 'Not Available';

    return Column(
      children: [
        Icon(icon, color: iconColor, size: 28),
        const SizedBox(height: 8),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          hasDate ? _formatDate(date) : 'Not Scheduled',
          style: theme.textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.bold,
            color: hasDate
                ? theme.colorScheme.onSurface
                : theme.colorScheme.onSurface.withValues(alpha: 0.5),
          ),
          textAlign: TextAlign.center,
        ),
        if (hasDate && !isPast) ...[
          const SizedBox(height: 2),
          Text(
            _getDaysUntil(date),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.primary,
              fontSize: 11,
            ),
          ),
        ],
      ],
    );
  }

  String _formatDate(String date) {
    try {
      DateTime? d;
      try { d = DateFormat('dd/MM/yyyy').parse(date); } catch (_) {}
      d ??= DateTime.tryParse(date);
      if (d != null) return DateFormat('dd/MM/yyyy').format(d);
    } catch (e) { debugPrint('Dashboard error: $e'); }
    return date;
  }

  String _getDaysUntil(String date) {
    try {
      DateTime? d;
      try { d = DateFormat('dd/MM/yyyy').parse(date); } catch (_) {}
      d ??= DateTime.tryParse(date);
      if (d != null) {
        final diff = DateTime(d.year, d.month, d.day)
            .difference(DateTime(DateTime.now().year, DateTime.now().month, DateTime.now().day))
            .inDays;
        if (diff == 0) return 'Today';
        if (diff == 1) return 'Tomorrow';
        if (diff > 0) return 'In $diff days';
      }
    } catch (e) { debugPrint('Dashboard error: $e'); }
    return '';
  }
}

// ── Smart Pharmacy Order Card ────────────────────────────────────
class _SmartPharmacyCard extends StatelessWidget {
  final Map<String, dynamic> order;
  final VoidCallback onTap;

  const _SmartPharmacyCard({required this.order, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final orderNumber = order['order_number']?.toString() ?? '';
    final status = order['status']?.toString().toUpperCase() ?? '';
    final color = _pharmacyStatusColor(status);

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color.withValues(alpha: 0.25)),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.15),
                shape: BoxShape.circle,
              ),
              child: Icon(LucideIcons.pill, color: color, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Pharmacy Order ${orderNumber.isNotEmpty ? orderNumber : ''}',
                    style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.bold),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(
                          color: color,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          _pharmacyStatusLabel(status),
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: Colors.white,
                            fontWeight: FontWeight.bold,
                            fontSize: 9,
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            Icon(LucideIcons.chevronRight, color: color, size: 20),
          ],
        ),
      ),
    );
  }

  Color _pharmacyStatusColor(String status) {
    switch (status) {
      case 'PLACED':
        return Colors.orange;
      case 'CONFIRMED':
        return Colors.blue;
      case 'DISPATCHED':
        return Colors.teal;
      case 'OUT_FOR_DELIVERY':
        return Colors.green;
      default:
        return Colors.grey;
    }
  }

  String _pharmacyStatusLabel(String status) {
    switch (status) {
      case 'PLACED':
        return 'PLACED';
      case 'CONFIRMED':
        return 'CONFIRMED';
      case 'DISPATCHED':
        return 'DISPATCHED 🚗';
      case 'OUT_FOR_DELIVERY':
        return 'ON THE WAY 🚗';
      default:
        return status;
    }
  }
}

// ── Smart Investigation Booking Card ─────────────────────────────
class _SmartInvestigationCard extends StatelessWidget {
  final Map<String, dynamic> booking;
  final VoidCallback onTap;

  const _SmartInvestigationCard({required this.booking, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bookingNumber = booking['booking_number']?.toString() ?? '';
    final status = booking['status']?.toString().toUpperCase() ?? '';
    final color = _invStatusColor(status);

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: color.withValues(alpha: 0.25)),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.15),
                shape: BoxShape.circle,
              ),
              child: Icon(LucideIcons.flaskConical, color: color, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Lab Booking ${bookingNumber.isNotEmpty ? bookingNumber : ''}',
                    style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.bold),
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      _invStatusLabel(status),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 9,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Icon(LucideIcons.chevronRight, color: color, size: 20),
          ],
        ),
      ),
    );
  }

  Color _invStatusColor(String status) {
    switch (status) {
      case 'BOOKED':
        return Colors.orange;
      case 'DISPATCHED':
        return Colors.teal;
      case 'SAMPLE_COLLECTED':
        return Colors.blue;
      default:
        return Colors.grey;
    }
  }

  String _invStatusLabel(String status) {
    switch (status) {
      case 'BOOKED':
        return 'BOOKED';
      case 'DISPATCHED':
        return 'COLLECTOR ON THE WAY';
      case 'SAMPLE_COLLECTED':
        return 'SAMPLE COLLECTED';
      default:
        return status;
    }
  }
}

// ── Smart Prescription Card ──────────────────────────────────────
class _SmartPrescriptionCard extends StatelessWidget {
  final Map<String, dynamic> prescription;
  final VoidCallback onOrderTap;
  final VoidCallback onViewTap;

  const _SmartPrescriptionCard({
    required this.prescription,
    required this.onOrderTap,
    required this.onViewTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final doctorName = prescription['doctor_name']?.toString() ?? 'Doctor';
    final rxNumber = prescription['prescription_number']?.toString() ?? '';
    final itemCount = (prescription['items'] as List?)?.length ??
        prescription['medicine_count'] ??
        prescription['item_count'] ??
        0;

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.purple.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.purple.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: Colors.purple.withValues(alpha: 0.15),
              shape: BoxShape.circle,
            ),
            child: const Icon(LucideIcons.fileText, color: Colors.purple, size: 22),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'New Prescription${rxNumber.isNotEmpty ? ' $rxNumber' : ''}',
                  style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.bold),
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  'Dr. $doctorName${itemCount > 0 ? ' • $itemCount medicines' : ''}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurface.withValues(alpha: 0.7),
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    SizedBox(
                      height: 28,
                      child: FilledButton(
                        onPressed: onOrderTap,
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          textStyle: const TextStyle(fontSize: 11),
                        ),
                        child: const Text('Order Medicines'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    SizedBox(
                      height: 28,
                      child: OutlinedButton(
                        onPressed: onViewTap,
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          textStyle: const TextStyle(fontSize: 11),
                        ),
                        child: const Text('View'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
