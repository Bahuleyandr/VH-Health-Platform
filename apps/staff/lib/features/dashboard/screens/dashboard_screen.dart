import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/platform_info.dart';
import '../../../core/providers/websocket_provider.dart';
import '../../../core/services/api_client.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/offline_queue.dart';
import '../../../core/services/recent_patients_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/services/attendance_api_service.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/first_run_welcome.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/patient_search_action.dart';
import '../../../core/widgets/theme_toggle_action.dart';
import '../../../l10n/app_strings.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  Map<String, dynamic>? _attendanceStatus;
  String? _staffId;
  String? _phone;
  StaffRole _role = StaffRole.general;
  bool _loading = true;

  // Stats
  int _appointmentCount = 0;
  // Workload counts surfaced as tappable stat cards above the feature
  // grid for clinical roles. Best-effort fetched in _loadData; default
  // to zero if the endpoint isn't available or 403s.
  int _dueMedsCount = 0;
  int _pendingAiReviewsCount = 0;
  int _activeAdmissionsCount = 0;
  // Recent-patients chips on dashboard. Locally cached via
  // SharedPreferences (RecentPatientsService); populated whenever
  // PatientTimelineScreen mounts. Cleared on logout for privacy on
  // shared ward workstations.
  List<Map<String, dynamic>> _recentPatients = const [];
  List<Map<String, dynamic>> _upcomingAppointments = [];
  List<dynamic> _recentNotifications = [];
  int _pendingSyncCount = 0;
  int _clinicalServiceTabIndex = 0;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      _staffId = await ApiConfig.getStaffId();
      _phone = await ApiConfig.getPhone();
      final roleStr = await AuthService.getRole();
      _role = StaffRole.fromString(roleStr);

      // Load all in parallel
      final futures = <Future>[];

      // Fetch campus geofence config (no-op after first success)
      futures.add(ScheduleApiService.fetchCampusConfig());

      futures.add(
        AttendanceApiService.getAttendanceStatus().then(
          (s) => _attendanceStatus = s,
          onError: (_) {},
        ),
      );

      // Appointments for clinical roles
      if (_role == StaffRole.doctor ||
          _role == StaffRole.nurse ||
          _role.isAdminTier) {
        final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
        futures.add(
          ScheduleApiService.getAppointments(
            doctorId: _role == StaffRole.doctor ? _staffId : null,
            date: today,
            limit: 20,
          ).then((data) {
            final list = _listFromApi(data, const ['appointments', 'items']);
            final pagination = data['pagination'];
            final rawTotal = pagination is Map
                ? pagination['total']
                : data['total'];
            _appointmentCount = rawTotal is int
                ? rawTotal
                : int.tryParse('$rawTotal') ?? list.length;
            _upcomingAppointments = list
                .where((a) {
                  final status = (a['status'] ?? '').toString().toLowerCase();
                  return status != 'cancelled' &&
                      status != 'completed' &&
                      status != 'done';
                })
                .take(3)
                .toList();
          }, onError: (_) {}),
        );
      }

      // Notifications
      if (_phone != null) {
        futures.add(
          HrApiService.getNotifications(_phone!).then(
            (n) => _recentNotifications = n.take(5).toList(),
            onError: (_) {},
          ),
        );
      }

      // Workload counts — only relevant for clinical roles. Each is
      // best-effort: errors are swallowed so the dashboard still
      // renders the rest if one endpoint is degraded.
      if (_role == StaffRole.nurse) {
        futures.add(
          ApiClient.get('/clinical/mar/due').then((r) {
            if (!r.isSuccess) return;
            final raw = r.raw;
            int count = 0;
            if (raw is Map<String, dynamic>) {
              final data = raw['data'];
              if (data is Map<String, dynamic>) {
                final list =
                    data['due'] ?? data['medications'] ?? data['items'];
                if (list is List) count = list.length;
              }
            }
            _dueMedsCount = count;
          }, onError: (_) {}),
        );
      }
      if (_role == StaffRole.doctor || _role.isAdminTier) {
        futures.add(
          ApiClient.get(
            '/clinical-ai/clinical/reviews',
            queryParameters: {'decision': 'pending', 'limit': '50'},
          ).then((r) {
            if (!r.isSuccess) return;
            final raw = r.raw;
            int count = 0;
            if (raw is Map<String, dynamic>) {
              final data = raw['data'];
              if (data is Map<String, dynamic>) {
                final list = data['reviews'] ?? data['items'];
                if (list is List) count = list.length;
              }
            }
            _pendingAiReviewsCount = count;
          }, onError: (_) {}),
        );
      }
      if (_role == StaffRole.doctor ||
          _role == StaffRole.nurse ||
          _role.isAdminTier) {
        futures.add(
          ApiClient.get(
            '/emr/admissions',
            queryParameters: {'page': '1', 'limit': '1'},
          ).then((r) {
            if (!r.isSuccess) return;
            final raw = r.raw;
            int count = 0;
            if (raw is Map<String, dynamic>) {
              final meta = raw['meta'];
              final pagination = meta is Map ? meta['pagination'] : null;
              final total = pagination is Map
                  ? (pagination['total'] ?? pagination['totalItems'])
                  : null;
              if (total is int) {
                count = total;
              } else if (total != null) {
                count = int.tryParse('$total') ?? 0;
              }
              final data = raw['data'];
              // GET /emr/admissions returns `data` as a List directly on the
              // current backend; older shapes wrap it as { admissions: [...] }
              // or { items: [...] }. Accept both so the stat doesn't silently
              // read zero whenever the shape flips.
              if (count == 0 && data is List) {
                count = data.length;
              } else if (count == 0 && data is Map<String, dynamic>) {
                final list = data['admissions'] ?? data['items'];
                if (list is List) count = list.length;
              }
            }
            _activeAdmissionsCount = count;
          }, onError: (_) {}),
        );
      }

      // Check offline queue
      futures.add(
        OfflineQueue.getPending().then(
          (items) => _pendingSyncCount = items.length,
          onError: (_) {},
        ),
      );

      // Recent patients (local-only).
      futures.add(
        RecentPatientsService.getAll().then(
          (rows) => _recentPatients = rows,
          onError: (_) {},
        ),
      );

      await Future.wait(futures);
    } catch (e) {
      // Non-blocking
      try {
        final roleStr = await AuthService.getRole();
        if (mounted) _role = StaffRole.fromString(roleStr);
      } catch (e) {
        debugPrint('dashboard_screen.dart: $e');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // Greeting now resolves through AppStrings so it localises into
  // Hindi/Tamil/Telugu when the device locale is set. Sourced from
  // `lib/l10n/app_strings.dart`.
  String _greetingFor(BuildContext context) {
    final s = AppStrings.of(context);
    final hour = DateTime.now().hour;
    if (hour < 12) return s.dashboardGreetingMorning;
    if (hour < 17) return s.dashboardGreetingAfternoon;
    return s.dashboardGreetingEvening;
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final today = DateFormat('EEEE, d MMMM yyyy').format(DateTime.now());
    final checkedIn =
        _attendanceStatus?['isCheckedIn'] == true ||
        _attendanceStatus?['status'] == 'checked-in';
    final canMarkAttendance = appDeviceModeForContext(
      context,
    ).canMarkAttendance;
    final features = RoleFeatures.getFeaturesForRole(_role);
    final dailyFeatures = _dailyFeaturesForRole(features);
    final clinicalServiceTabs = _buildClinicalServiceTabs(features);
    final promotedIds = clinicalServiceTabs == null
        ? dailyFeatures.map((feature) => feature.id).toSet()
        : _clinicalServiceFeatureIdsForRole();
    final moreFeatures = _moreFeaturesForRole(features, promotedIds);

    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      body: RefreshIndicator(
        onRefresh: _loadData,
        child: CustomScrollView(
          slivers: [
            // App bar
            SliverAppBar(
              expandedHeight: 196,
              pinned: true,
              backgroundColor: AppTheme.primaryBlue,
              foregroundColor: Colors.white,
              leading: const NavigationBackAction(closeOnFallback: true),
              actions: [
                Consumer<WebSocketProvider>(
                  builder: (context, wsProv, _) {
                    return Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          Icon(
                            Icons.wifi,
                            color: wsProv.isConnected
                                ? Colors.greenAccent
                                : Colors.white38,
                            size: 20,
                          ),
                          if (wsProv.notifications.isNotEmpty)
                            Positioned(
                              top: 0,
                              right: 0,
                              child: Container(
                                width: 8,
                                height: 8,
                                decoration: const BoxDecoration(
                                  color: Colors.redAccent,
                                  shape: BoxShape.circle,
                                ),
                              ),
                            ),
                        ],
                      ),
                    );
                  },
                ),
                const ThemeToggleAction(),
                if (_role != StaffRole.housekeeping &&
                    _role != StaffRole.housekeepingIncharge &&
                    _role != StaffRole.maintenance)
                  const PatientSearchAction(),
                const LogoutAction(),
              ],
              flexibleSpace: FlexibleSpaceBar(
                background: Container(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [AppTheme.primaryBlue, AppTheme.accentCyan],
                    ),
                  ),
                  padding: const EdgeInsets.fromLTRB(20, 80, 20, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Text(
                        _greetingFor(context),
                        style: const TextStyle(
                          color: Colors.white70,
                          fontSize: 14,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${s.dashboardWelcomeBack} 👋',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 22,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 220),
                            child: Text(
                              today,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: Colors.white60,
                                fontSize: 12,
                              ),
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 3,
                            ),
                            decoration: BoxDecoration(
                              color: Colors.white.withValues(alpha: 0.2),
                              borderRadius: BorderRadius.circular(20),
                              border: Border.all(
                                color: Colors.white.withValues(alpha: 0.4),
                              ),
                            ),
                            child: Text(
                              _role.displayName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),

            SliverToBoxAdapter(
              child: _loading
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 48),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  : Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // Attendance status card — phone-only. The
                          // backend rejects attendance marking from the
                          // desktop app (`requireDeviceType('mobile')`),
                          // so we hide the card on desktop too instead
                          // of letting users tap into a 403.
                          if (canMarkAttendance) ...[
                            _AttendanceStatusCard(
                              isCheckedIn: checkedIn,
                              checkInTime: _attendanceStatus?['checkInTime'],
                              onTap: () => context.push('/attendance'),
                            ),
                            const SizedBox(height: 16),
                          ],

                          // Pending offline sync banner
                          if (_pendingSyncCount > 0)
                            Container(
                              margin: const EdgeInsets.only(bottom: 16),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 14,
                                vertical: 10,
                              ),
                              decoration: BoxDecoration(
                                color: AppTheme.warningAmber.withValues(
                                  alpha: 0.1,
                                ),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(
                                  color: AppTheme.warningAmber.withValues(
                                    alpha: 0.4,
                                  ),
                                ),
                              ),
                              child: Row(
                                children: [
                                  const Icon(
                                    Icons.cloud_off,
                                    color: AppTheme.warningAmber,
                                    size: 20,
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      s.dashboardSyncPending(_pendingSyncCount),
                                      style: const TextStyle(
                                        color: AppTheme.warningAmber,
                                        fontWeight: FontWeight.w600,
                                        fontSize: 13,
                                      ),
                                    ),
                                  ),
                                  const Icon(
                                    Icons.sync,
                                    color: AppTheme.warningAmber,
                                    size: 18,
                                  ),
                                ],
                              ),
                            ),

                          // Live WS notification banner
                          Consumer<WebSocketProvider>(
                            builder: (context, wsProv, _) {
                              if (wsProv.notifications.isEmpty) {
                                return const SizedBox.shrink();
                              }
                              return GestureDetector(
                                onTap: () => context.push('/notifications'),
                                child: Container(
                                  margin: const EdgeInsets.only(bottom: 16),
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 14,
                                    vertical: 10,
                                  ),
                                  decoration: BoxDecoration(
                                    color: AppTheme.primaryBlue.withValues(
                                      alpha: 0.08,
                                    ),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(
                                      color: AppTheme.primaryBlue.withValues(
                                        alpha: 0.2,
                                      ),
                                    ),
                                  ),
                                  child: Row(
                                    children: [
                                      const Icon(
                                        Icons.notifications_active,
                                        color: AppTheme.primaryBlue,
                                        size: 20,
                                      ),
                                      const SizedBox(width: 10),
                                      Expanded(
                                        child: Text(
                                          s.dashboardLiveNotifications(
                                            wsProv.notifications.length,
                                          ),
                                          style: const TextStyle(
                                            color: AppTheme.primaryBlue,
                                            fontWeight: FontWeight.w600,
                                            fontSize: 13,
                                          ),
                                        ),
                                      ),
                                      const Icon(
                                        Icons.chevron_right,
                                        color: AppTheme.primaryBlue,
                                        size: 18,
                                      ),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),

                          // First-run welcome card (only shows once,
                          // then writes a SharedPreferences flag).
                          const FirstRunWelcome(),

                          // Quick stats row
                          _buildQuickStats(),
                          const SizedBox(height: 16),

                          // Recent patients (locally cached). Only renders
                          // if the user has actually opened a patient
                          // chart at some point.
                          if (_recentPatients.isNotEmpty) ...[
                            _buildRecentPatients(),
                            const SizedBox(height: 16),
                          ],

                          // Quick actions
                          Text(
                            s.dashboardQuickActionsHeader,
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                              color: AppTheme.textPrimary,
                            ),
                          ),
                          const SizedBox(height: 10),
                          _buildQuickActions(),
                          const SizedBox(height: 16),

                          // Upcoming appointments (clinical roles)
                          if (_upcomingAppointments.isNotEmpty) ...[
                            _buildSectionHeader(
                              s.dashboardUpcomingAppointmentsHeader,
                              '/appointments',
                            ),
                            const SizedBox(height: 8),
                            ..._upcomingAppointments.map(_buildAppointmentCard),
                            const SizedBox(height: 16),
                          ],

                          // Recent activity
                          if (_recentNotifications.isNotEmpty) ...[
                            _buildSectionHeader(
                              s.dashboardRecentActivity,
                              '/notifications',
                            ),
                            const SizedBox(height: 8),
                            ..._recentNotifications.map(_buildActivityItem),
                            const SizedBox(height: 16),
                          ],

                          // Daily work stays on the front screen; low-frequency
                          // self-service/admin tools are tucked into More tools.
                          if (dailyFeatures.isNotEmpty ||
                              clinicalServiceTabs != null) ...[
                            Text(
                              s.dashboardDailyWork,
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.bold,
                                color: AppTheme.textPrimary,
                              ),
                            ),
                            const SizedBox(height: 10),
                            clinicalServiceTabs ??
                                _buildFeatureGrid(dailyFeatures),
                            const SizedBox(height: 16),
                          ],

                          if (moreFeatures.isNotEmpty)
                            _buildMoreTools(moreFeatures),
                          const SizedBox(height: 24),
                        ],
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  List<DashboardFeature> _dailyFeaturesForRole(
    List<DashboardFeature> features,
  ) {
    final dailyIds = switch (_role) {
      StaffRole.doctor || StaffRole.dutyDoctor => {
        'front_office_workbench',
        'queue',
        'clinical_ai_review_queue',
        'op_ai_assist',
        'appointments',
        'appointment_queue',
        'patient_records',
        'prescriptions',
        'investigation_results',
        'theatre',
        'radiology',
        'patient_command_board',
        'bed_board',
        'ward_mode',
        'blood_bank',
      },
      StaffRole.nurse ||
      StaffRole.nursingSuperintendent ||
      StaffRole.nursingIncharge ||
      StaffRole.opStaffNurse ||
      StaffRole.opIncharge => {
        'front_office_workbench',
        'appointments',
        'appointment_queue',
        'clinical_ai_review_queue',
        'patient_records',
        'pharmacy_orders',
        'vitals',
        'nursing_notes',
        'handover',
        'lab_bookings',
        'investigation_results',
        'patient_command_board',
        'bed_board',
        'ward_mode',
        'dietary',
      },
      StaffRole.hr => {
        'hr_dashboard',
        'staff_roster',
        'staff_management',
        'performance',
        'staff_directory',
      },
      StaffRole.medicalSuperintendent => {
        'front_office_workbench',
        'appointments',
        'appointment_queue',
        'clinical_ai_review_queue',
        'op_ai_assist',
        'patient_records',
        'patient_command_board',
        'bed_board',
        'ward_mode',
        'theatre',
        'radiology',
        'blood_bank',
        'dietary',
        'staff_roster',
      },
      StaffRole.admin || StaffRole.superAdmin => {
        'front_office_workbench',
        'appointments',
        'appointment_queue',
        'clinical_ai_review_queue',
        'patient_records',
        'pharmacy_orders',
        'investigations_upload',
        'investigation_results',
        'lab_bookings',
        'patient_command_board',
        'bed_board',
        'ward_mode',
        'theatre',
        'radiology',
        'blood_bank',
        'dietary',
        'staff_roster',
        'hr_dashboard',
        'staff_management',
      },
      StaffRole.pharmacy => {
        'pharmacy_roster',
        'pharmacy_orders',
        'patient_command_board',
        'clinical_ai_review_queue',
      },
      StaffRole.lab => {
        'investigations_upload',
        'investigation_results',
        'lab_bookings',
      },
      StaffRole.housekeeping => {
        'bed_board',
        'housekeeping_hub',
        'housekeeping_tasks',
      },
      StaffRole.housekeepingIncharge => {
        'bed_board',
        'housekeeping_roster',
        'housekeeping_command',
        'housekeeping_hub',
        'housekeeping_tasks',
      },
      StaffRole.receptionist || StaffRole.receptionIncharge => {
        'front_office_workbench',
        'billing_desk',
        'reception_counter',
        'appointment_queue',
        'reception_roster',
      },
      StaffRole.billingStaff ||
      StaffRole.billingIncharge ||
      StaffRole.financeIncharge => {
        'front_office_workbench',
        'billing_desk',
        'appointment_queue',
      },
      StaffRole.admissionOfficer ||
      StaffRole.insuranceCoordinator ||
      StaffRole.ipdCounsellor => {
        'front_office_workbench',
        'billing_desk',
        'reception_counter',
        'appointment_queue',
      },
      StaffRole.driver => {'driver_roster'},
      StaffRole.maintenance => {'maintenance_roster', 'staff_directory'},
      StaffRole.general => {
        'appointment_queue',
        'housekeeping_hub',
        'housekeeping_tasks',
      },
    };

    return features.where((feature) => dailyIds.contains(feature.id)).toList();
  }

  List<DashboardFeature> _moreFeaturesForRole(
    List<DashboardFeature> features,
    Set<String> promotedIds,
  ) {
    const alreadyPromotedIds = {
      'attendance',
      'messaging',
      'leave',
      'duty_preference',
    };
    return features
        .where(
          (feature) =>
              !promotedIds.contains(feature.id) &&
              !alreadyPromotedIds.contains(feature.id),
        )
        .toList();
  }

  Set<String> _clinicalServiceFeatureIdsForRole() {
    return switch (_role) {
      StaffRole.nurse => {
        'appointments',
        'appointment_queue',
        'clinical_ai_review_queue',
        'lab_bookings',
        'nursing_notes',
        'pharmacy_orders',
        'investigation_results',
        'patient_records',
        'patient_command_board',
        'bed_board',
        'ward_mode',
        'discharge_hub',
        'vitals',
        'dietary',
        'handover',
      },
      StaffRole.doctor => {
        'appointment_queue',
        'queue',
        'clinical_ai_review_queue',
        'appointments',
        'patient_records',
        'prescriptions',
        'investigation_results',
        'patient_command_board',
        'bed_board',
        'ward_mode',
        'discharge_hub',
        'radiology',
        'theatre',
        'blood_bank',
      },
      StaffRole.admin || StaffRole.superAdmin => {
        'appointments',
        'appointment_queue',
        'clinical_ai_review_queue',
        'patient_records',
        'pharmacy_orders',
        'investigations_upload',
        'investigation_results',
        'lab_bookings',
        'patient_command_board',
        'bed_board',
        'ward_mode',
        'discharge_hub',
        'dietary',
        'theatre',
        'radiology',
        'blood_bank',
      },
      _ => const <String>{},
    };
  }

  Widget? _buildClinicalServiceTabs(List<DashboardFeature> features) {
    final groups = _clinicalServiceGroupsForRole(features);
    if (groups == null || groups.every((group) => group.tiles.isEmpty)) {
      return null;
    }

    final selectedIndex = _clinicalServiceTabIndex
        .clamp(0, groups.length - 1)
        .toInt();
    final selectedGroup = groups[selectedIndex];

    return Container(
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppTheme.divider),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 10,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      padding: const EdgeInsets.all(10),
      child: Column(
        children: [
          _buildServiceTabSwitcher(groups, selectedIndex),
          const SizedBox(height: 12),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 180),
            switchInCurve: Curves.easeOut,
            switchOutCurve: Curves.easeIn,
            child: selectedGroup.tiles.isEmpty
                ? _ServiceEmptyState(
                    key: ValueKey(selectedGroup.label),
                    label: selectedGroup.emptyLabel,
                  )
                : _buildServiceGrid(
                    selectedGroup.tiles,
                    key: ValueKey(selectedGroup.label),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildServiceTabSwitcher(
    List<_ClinicalServiceGroup> groups,
    int selectedIndex,
  ) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppTheme.backgroundGrey,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Row(
        children: [
          for (var i = 0; i < groups.length; i++)
            Expanded(
              child: _ServiceTabButton(
                label: groups[i].label,
                selected: selectedIndex == i,
                onTap: () => setState(() => _clinicalServiceTabIndex = i),
              ),
            ),
        ],
      ),
    );
  }

  List<_ClinicalServiceGroup>? _clinicalServiceGroupsForRole(
    List<DashboardFeature> features,
  ) {
    final s = AppStrings.of(context);

    return switch (_role) {
      StaffRole.nurse => [
        _ClinicalServiceGroup(
          label: s.dashboardOpServices,
          emptyLabel: s.dashboardNoOpServices,
          tiles: _serviceTilesForIds(
            features,
            [
              'appointments',
              'appointment_queue',
              'clinical_ai_review_queue',
              'lab_bookings',
              'nursing_notes',
              'pharmacy_orders',
              'investigation_results',
              'patient_records',
            ],
            titleOverrides: {
              'lab_bookings': s.dashboardOpLabBookings,
              'nursing_notes': s.dashboardOpNursingNotes,
              'pharmacy_orders': s.dashboardOpPharmacy,
              'investigation_results': s.dashboardOpLabResults,
              'patient_records': s.dashboardOpPatientRecords,
            },
            routeOverrides: _serviceContextRoutes('op'),
          ),
        ),
        _ClinicalServiceGroup(
          label: s.dashboardIpServices,
          emptyLabel: s.dashboardNoIpServices,
          tiles: _serviceTilesForIds(
            features,
            [
              'patient_command_board',
              'bed_board',
              'ward_mode',
              'discharge_hub',
              'vitals',
              'nursing_notes',
              'lab_bookings',
              'investigation_results',
              'pharmacy_orders',
              'dietary',
              'handover',
              'patient_records',
            ],
            titleOverrides: {
              'nursing_notes': s.dashboardIpNursingNotes,
              'lab_bookings': s.dashboardIpLabBookings,
              'investigation_results': s.dashboardIpLabResults,
              'pharmacy_orders': s.dashboardIpPharmacy,
              'patient_records': s.dashboardIpPatientRecords,
            },
            routeOverrides: _serviceContextRoutes('ip'),
          ),
        ),
      ],
      StaffRole.doctor => [
        _ClinicalServiceGroup(
          label: s.dashboardOpServices,
          emptyLabel: s.dashboardNoOpServices,
          tiles: _serviceTilesForIds(
            features,
            [
              'appointment_queue',
              'queue',
              'clinical_ai_review_queue',
              'op_ai_assist',
              'appointments',
              'patient_records',
              'prescriptions',
              'investigation_results',
            ],
            titleOverrides: {
              'patient_records': s.dashboardOpPatientRecords,
              'investigation_results': s.dashboardOpLabResults,
            },
            routeOverrides: _serviceContextRoutes('op'),
          ),
        ),
        _ClinicalServiceGroup(
          label: s.dashboardIpServices,
          emptyLabel: s.dashboardNoIpServices,
          tiles: _serviceTilesForIds(
            features,
            [
              'patient_command_board',
              'bed_board',
              'ward_mode',
              'discharge_hub',
              'patient_records',
              'prescriptions',
              'investigation_results',
              'radiology',
              'theatre',
              'blood_bank',
            ],
            titleOverrides: {
              'patient_records': s.dashboardIpPatientRecords,
              'investigation_results': s.dashboardIpLabResults,
            },
            routeOverrides: _serviceContextRoutes('ip'),
          ),
        ),
      ],
      StaffRole.admin || StaffRole.superAdmin => [
        _ClinicalServiceGroup(
          label: s.dashboardOpServices,
          emptyLabel: s.dashboardNoOpServices,
          tiles: _serviceTilesForIds(
            features,
            [
              'appointments',
              'appointment_queue',
              'clinical_ai_review_queue',
              'op_ai_assist',
              'patient_records',
              'pharmacy_orders',
              'investigations_upload',
              'investigation_results',
              'lab_bookings',
            ],
            titleOverrides: {
              'patient_records': s.dashboardOpPatientRecords,
              'pharmacy_orders': s.dashboardOpPharmacy,
              'investigation_results': s.dashboardOpLabResults,
              'lab_bookings': s.dashboardOpLabBookings,
            },
            routeOverrides: _serviceContextRoutes('op'),
          ),
        ),
        _ClinicalServiceGroup(
          label: s.dashboardIpServices,
          emptyLabel: s.dashboardNoIpServices,
          tiles: _serviceTilesForIds(
            features,
            [
              'patient_command_board',
              'bed_board',
              'ward_mode',
              'discharge_hub',
              'patient_records',
              'pharmacy_orders',
              'investigations_upload',
              'investigation_results',
              'lab_bookings',
              'dietary',
              'theatre',
              'radiology',
              'blood_bank',
            ],
            titleOverrides: {
              'patient_records': s.dashboardIpPatientRecords,
              'pharmacy_orders': s.dashboardIpPharmacy,
              'investigation_results': s.dashboardIpLabResults,
              'lab_bookings': s.dashboardIpLabBookings,
            },
            routeOverrides: _serviceContextRoutes('ip'),
          ),
        ),
      ],
      _ => null,
    };
  }

  List<_ServiceTile> _serviceTilesForIds(
    List<DashboardFeature> features,
    List<String> ids, {
    Map<String, String> titleOverrides = const {},
    Map<String, String> routeOverrides = const {},
  }) {
    final byId = {for (final feature in features) feature.id: feature};
    return [
      for (final id in ids)
        if (byId[id] != null)
          _ServiceTile.fromFeature(
            byId[id]!,
            title: titleOverrides[id] ?? byId[id]!.title,
            route: routeOverrides[id] ?? byId[id]!.route,
          ),
    ];
  }

  Map<String, String> _serviceContextRoutes(String context) => {
    'appointments': '/appointments?context=$context',
    'appointment_queue': '/appointment-queue?context=$context',
    'queue': '/queue?context=$context',
    'patient_records': '/patient-records?context=$context',
    'prescriptions': '/prescriptions?context=$context',
    'pharmacy_orders': '/pharmacy?context=$context',
    'lab_bookings': '/lab-bookings?context=$context',
    'investigation_results': '/investigations?context=$context',
    'investigations_upload': '/investigations?context=$context',
    'patient_command_board': '/patient-command-board?context=$context',
    'ward_mode': '/ward-mode?context=$context',
    'nursing_notes': '/nursing-notes?context=$context',
    'vitals': '/vitals?context=$context',
    'handover': '/handover?context=$context',
    'dietary': '/dietary?context=$context',
  };

  Widget _buildFeatureGrid(List<DashboardFeature> features) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final crossAxisCount = width >= 900
            ? 6
            : width >= 640
            ? 4
            : 3;
        return GridView.builder(
          itemCount: features.length,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: crossAxisCount,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            childAspectRatio: 1.0,
          ),
          itemBuilder: (context, index) {
            final feature = features[index];
            return _FeatureButton(
              icon: feature.icon,
              label: feature.title,
              color: feature.color,
              route: feature.route,
            );
          },
        );
      },
    );
  }

  Widget _buildServiceGrid(List<_ServiceTile> tiles, {Key? key}) {
    return LayoutBuilder(
      key: key,
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final crossAxisCount = width >= 900
            ? 5
            : width >= 640
            ? 4
            : 2;
        return GridView.builder(
          itemCount: tiles.length,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: crossAxisCount,
            mainAxisSpacing: 10,
            crossAxisSpacing: 10,
            childAspectRatio: width >= 640 ? 1.12 : 1.05,
          ),
          itemBuilder: (context, index) {
            final tile = tiles[index];
            return _FeatureButton(
              icon: tile.icon,
              label: tile.title,
              color: tile.color,
              route: tile.route,
            );
          },
        );
      },
    );
  }

  Widget _buildMoreTools(List<DashboardFeature> features) {
    final s = AppStrings.of(context);
    final textColor = AppTheme.textPrimary;
    final subtitleColor = AppTheme.textSecondary;
    return Container(
      decoration: BoxDecoration(
        color: AppTheme.cardSurface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
          childrenPadding: const EdgeInsets.fromLTRB(6, 0, 6, 8),
          iconColor: subtitleColor,
          collapsedIconColor: subtitleColor,
          textColor: textColor,
          collapsedTextColor: textColor,
          leading: Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: AppTheme.primaryBlue.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(
              Icons.apps_outlined,
              color: AppTheme.primaryBlue,
              size: 20,
            ),
          ),
          title: Text(
            s.dashboardMoreTools,
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w700,
              color: textColor,
            ),
          ),
          subtitle: Text(
            s.dashboardMoreToolsHint,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12, color: subtitleColor),
          ),
          children: features
              .map(
                (feature) => _SecondaryFeatureTile(
                  icon: feature.icon,
                  label: feature.title,
                  color: feature.color,
                  route: feature.route,
                ),
              )
              .toList(),
        ),
      ),
    );
  }

  // Recent-patients horizontal chip strip. Each chip routes back to
  // the patient's timeline. Capped at 5 entries by RecentPatientsService.
  //
  // Semantics: wrap the strip in a `Semantics(container: true, label:
  // 'Recent patients')` so screen readers announce "Recent patients,
  // list" as the user enters the section, then read each chip with
  // its position ("1 of 5: Demo Patient Ravi, button"). Without the
  // container the chips read in isolation with no scoping.
  Widget _buildRecentPatients() {
    final s = AppStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          s.dashboardRecentPatientsHeader,
          style: TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.bold,
            color: AppTheme.textPrimary,
          ),
        ),
        const SizedBox(height: 8),
        Semantics(
          container: true,
          label: 'Recent patients (${_recentPatients.length})',
          child: SizedBox(
            height: 44,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: _recentPatients.length,
              separatorBuilder: (context, index) => const SizedBox(width: 8),
              itemBuilder: (context, i) {
                final p = _recentPatients[i];
                final uid = (p['uid'] ?? '').toString();
                final name = (p['name'] ?? 'Patient').toString();
                return Semantics(
                  button: true,
                  label: '${i + 1} of ${_recentPatients.length}: $name',
                  hint: 'Opens patient chart',
                  child: ActionChip(
                    avatar: ExcludeSemantics(
                      child: CircleAvatar(
                        backgroundColor: AppTheme.primaryBlue.withValues(
                          alpha: 0.15,
                        ),
                        child: Text(
                          name.isNotEmpty ? name[0].toUpperCase() : '?',
                          style: const TextStyle(
                            fontSize: 12,
                            color: AppTheme.primaryBlue,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ),
                    label: Text(
                      name,
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    onPressed: uid.isEmpty
                        ? null
                        : () => context.push(
                            '/emr/timeline/$uid?name=${Uri.encodeQueryComponent(name)}',
                          ),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }

  // Role-aware "today's workload" cards. Replaces the generic
  // appointments+notifications row with a per-role surface that
  // surfaces the metric staff actually open the app to check:
  //
  //   Nurse   → Due meds, Today's appts, Active admissions, Notifications
  //   Doctor  → Today's appts, Pending AI reviews, Active admissions, Notifications
  //   Admin   → Today's appts, Pending AI reviews, Active admissions, Notifications
  //   Pharmacy/Lab/HR/General → just notifications (existing behaviour)
  //
  // Every card is tappable and routes to the screen where the metric
  // can be acted on.
  Widget _buildQuickStats() {
    final s = AppStrings.of(context);
    final stats = <_StatItem>[];

    // Nurse: due meds count is the headline metric.
    if (_role == StaffRole.nurse) {
      stats.add(
        _StatItem(
          icon: Icons.medication_outlined,
          label: s.dashboardStatDueMeds,
          value: '$_dueMedsCount',
          color: const Color(0xFFC62828),
          route: '/mar/due',
        ),
      );
    }

    if (_role == StaffRole.doctor ||
        _role == StaffRole.nurse ||
        _role.isAdminTier) {
      stats.add(
        _StatItem(
          icon: Icons.calendar_today,
          label: s.dashboardStatAppointments,
          value: '$_appointmentCount',
          color: const Color(0xFF6A1B9A),
          route: '/appointments',
        ),
      );
    }

    // Doctor / admin: pending AI reviews to sign off.
    if (_role == StaffRole.doctor || _role.isAdminTier) {
      stats.add(
        _StatItem(
          icon: Icons.fact_check_outlined,
          label: s.dashboardStatReviewQueue,
          value: '$_pendingAiReviewsCount',
          color: const Color(0xFF00838F),
          route: '/clinical-ai/queue',
        ),
      );
    }

    // Active admissions (everyone clinical sees this — the patient list
    // is the natural drill-down for any of the other counts).
    if (_role == StaffRole.doctor ||
        _role == StaffRole.nurse ||
        _role.isAdminTier) {
      stats.add(
        _StatItem(
          icon: Icons.local_hotel_outlined,
          label: s.dashboardStatInpatients,
          value: '$_activeAdmissionsCount',
          color: const Color(0xFF1565C0),
          route: '/emr/admissions',
        ),
      );
    }

    stats.add(
      _StatItem(
        icon: Icons.notifications_active,
        label: s.dashboardStatAlerts,
        value: '${_recentNotifications.length}',
        color: const Color(0xFFE65100),
        route: '/notifications',
      ),
    );

    if (stats.isEmpty) return const SizedBox.shrink();

    return Row(
      children: stats.map((s) {
        return Expanded(
          child: Card(
            margin: const EdgeInsets.symmetric(horizontal: 4),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: s.route != null ? () => context.push(s.route!) : null,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    Icon(s.icon, color: s.color, size: 22),
                    const SizedBox(height: 6),
                    Text(
                      s.value,
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                        color: s.color,
                      ),
                    ),
                    Text(
                      s.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 10, color: Colors.grey),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      }).toList(),
    );
  }

  Widget _buildQuickActions() {
    final s = AppStrings.of(context);
    final actions = <_QuickAction>[];
    final canReviewClinicalAi =
        _role == StaffRole.doctor ||
        _role == StaffRole.nurse ||
        _role == StaffRole.pharmacy ||
        _role.isAdminTier;

    // Attendance — phone-only. The backend's requireDeviceType('mobile')
    // gate rejects desktop attempts; hide the tile on desktop so the user
    // doesn't get a 403 surprise.
    if (appDeviceModeForContext(context).canMarkAttendance) {
      actions.add(
        _QuickAction(
          icon: Icons.fingerprint,
          label: s.dashboardActionCheckInOut,
          route: '/attendance',
          color: const Color(0xFF1565C0),
        ),
      );
    }

    // Schedule for all
    actions.add(
      _QuickAction(
        icon: Icons.schedule,
        label: s.dashboardActionShiftSchedule,
        route: '/schedule',
        color: const Color(0xFF00838F),
      ),
    );

    if (canReviewClinicalAi) {
      actions.add(
        _QuickAction(
          icon: Icons.fact_check_outlined,
          label: s.dashboardStatReviewQueue,
          route: '/clinical-ai/queue',
          color: const Color(0xFF00838F),
        ),
      );
    }

    // Messages for all
    actions.add(
      _QuickAction(
        icon: Icons.chat_outlined,
        label: s.dashboardActionMessages,
        route: '/messaging',
        color: const Color(0xFF1565C0),
      ),
    );

    // Role-specific
    if (_role == StaffRole.doctor) {
      actions.add(
        _QuickAction(
          icon: Icons.medication_liquid,
          label: s.dashboardActionPrescriptions,
          route: '/prescriptions',
          color: const Color(0xFF00838F),
        ),
      );
      actions.add(
        _QuickAction(
          icon: Icons.biotech,
          label: s.dashboardActionInvestigations,
          route: '/investigations',
          color: const Color(0xFF0097A7),
        ),
      );
    } else if (_role == StaffRole.nurse) {
      actions.add(
        _QuickAction(
          icon: Icons.monitor_heart,
          label: s.dashboardActionVitals,
          route: '/vitals',
          color: const Color(0xFFC62828),
        ),
      );
      actions.add(
        _QuickAction(
          icon: Icons.swap_horiz,
          label: s.dashboardActionHandover,
          route: '/handover',
          color: const Color(0xFF00695C),
        ),
      );
    } else if (_role == StaffRole.pharmacy) {
      actions.add(
        _QuickAction(
          icon: Icons.medication,
          label: s.dashboardActionPharmacy,
          route: '/pharmacy',
          color: const Color(0xFFE65100),
        ),
      );
    } else if (_role == StaffRole.lab) {
      actions.add(
        _QuickAction(
          icon: Icons.upload_file,
          label: s.dashboardActionUploadResults,
          route: '/investigations',
          color: const Color(0xFF0097A7),
        ),
      );
    }

    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: actions.map((a) {
        return ActionChip(
          avatar: Icon(a.icon, size: 18, color: a.color),
          label: Text(a.label),
          onPressed: () => context.push(a.route),
          backgroundColor: a.color.withValues(alpha: 0.08),
          side: BorderSide(color: a.color.withValues(alpha: 0.2)),
        );
      }).toList(),
    );
  }

  Widget _buildSectionHeader(String title, String route) {
    final s = AppStrings.of(context);
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          title,
          style: TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.bold,
            color: AppTheme.textPrimary,
          ),
        ),
        TextButton(
          onPressed: () => context.push(route),
          child: Text(s.dashboardSeeAll),
        ),
      ],
    );
  }

  Widget _buildAppointmentCard(Map<String, dynamic> apt) {
    final patient = apt['patient'];
    final patientName = _firstText([
      apt['patient_name'],
      apt['patientName'],
      patient is Map ? patient['name'] : null,
      apt['name'],
      apt['patient_phone'],
      apt['phone'],
    ], fallback: 'Patient');
    final time = _firstText([
      apt['appointment_time'],
      apt['time'],
      apt['scheduledTime'],
      apt['scheduled_time'],
    ]);
    final type = _firstText([
      apt['reason'],
      apt['type'],
      apt['appointmentType'],
      apt['visit_type'],
    ]);
    String timeStr = '';
    if (time.isNotEmpty) {
      try {
        timeStr = DateFormat('HH:mm').format(DateTime.parse(time));
      } catch (e) {
        timeStr = time;
      }
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: const CircleAvatar(
          backgroundColor: Color(0xFFE8EAF6),
          child: Icon(Icons.person, color: Color(0xFF3949AB)),
        ),
        title: Text(
          patientName,
          style: const TextStyle(fontWeight: FontWeight.w600),
        ),
        subtitle: Text(
          [
            if (timeStr.isNotEmpty) timeStr,
            if (type.toString().isNotEmpty) type,
          ].join(' • '),
        ),
        trailing: const Icon(Icons.chevron_right, color: Colors.grey),
        onTap: () => context.push('/appointments'),
      ),
    );
  }

  List<Map<String, dynamic>> _listFromApi(
    Map<String, dynamic> data,
    List<String> keys,
  ) {
    dynamic value;
    for (final key in keys) {
      value = data[key];
      if (value != null) break;
    }
    value ??= data['data'];
    if (value is Map) {
      return _listFromApi(Map<String, dynamic>.from(value), keys);
    }
    if (value is List) {
      return value
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
    }
    return const [];
  }

  String _firstText(List<dynamic> values, {String fallback = ''}) {
    for (final value in values) {
      final text = value?.toString().trim() ?? '';
      if (text.isNotEmpty && text.toLowerCase() != 'null') return text;
    }
    return fallback;
  }

  Widget _buildActivityItem(dynamic notification) {
    final n = notification is Map<String, dynamic>
        ? notification
        : <String, dynamic>{};
    final title = n['title'] ?? 'Notification';
    final body = n['body'] ?? n['message'] ?? '';
    final ts = n['createdAt'] ?? n['timestamp'] ?? '';
    String timeStr = '';
    if (ts.toString().isNotEmpty) {
      try {
        final dt = DateTime.parse(ts.toString());
        final diff = DateTime.now().difference(dt);
        if (diff.inMinutes < 60) {
          timeStr = '${diff.inMinutes}m ago';
        } else if (diff.inHours < 24) {
          timeStr = '${diff.inHours}h ago';
        } else {
          timeStr = DateFormat('d MMM').format(dt);
        }
      } catch (e) {
        debugPrint('dashboard_screen.dart: $e');
      }
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 6),
      child: ListTile(
        dense: true,
        leading: const Icon(Icons.circle, size: 8, color: AppTheme.primaryBlue),
        title: Text(
          title.toString(),
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
        ),
        subtitle: body.toString().isNotEmpty
            ? Text(
                body.toString(),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
              )
            : null,
        trailing: timeStr.isNotEmpty
            ? Text(
                timeStr,
                style: const TextStyle(fontSize: 11, color: Colors.grey),
              )
            : null,
      ),
    );
  }
}

class _StatItem {
  final IconData icon;
  final String label;
  final String value;
  final Color color;
  // Optional route — when set, the stat card wraps in an InkWell that
  // navigates here on tap (used by every clinical-role stat card so
  // the dashboard becomes a workload launcher).
  final String? route;
  const _StatItem({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
    this.route,
  });
}

class _QuickAction {
  final IconData icon;
  final String label;
  final String route;
  final Color color;
  const _QuickAction({
    required this.icon,
    required this.label,
    required this.route,
    required this.color,
  });
}

class _ClinicalServiceGroup {
  final String label;
  final String emptyLabel;
  final List<_ServiceTile> tiles;

  const _ClinicalServiceGroup({
    required this.label,
    required this.emptyLabel,
    required this.tiles,
  });
}

class _ServiceTile {
  final IconData icon;
  final String title;
  final String route;
  final Color color;

  const _ServiceTile({
    required this.icon,
    required this.title,
    required this.route,
    required this.color,
  });

  factory _ServiceTile.fromFeature(
    DashboardFeature feature, {
    required String title,
    required String route,
  }) {
    return _ServiceTile(
      icon: feature.icon,
      title: title,
      route: route,
      color: feature.color,
    );
  }
}

class _ServiceTabButton extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _ServiceTabButton({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final color = selected ? AppTheme.primaryBlue : AppTheme.textSecondary;
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected
            ? AppTheme.primaryBlue.withValues(alpha: 0.12)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: color,
                fontSize: 13,
                fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ServiceEmptyState extends StatelessWidget {
  final String label;

  const _ServiceEmptyState({super.key, required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
      decoration: BoxDecoration(
        color: AppTheme.backgroundGrey,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.divider),
      ),
      child: Text(
        label,
        textAlign: TextAlign.center,
        style: TextStyle(
          color: AppTheme.textSecondary,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _AttendanceStatusCard extends StatelessWidget {
  final bool isCheckedIn;
  final String? checkInTime;
  final VoidCallback onTap;

  const _AttendanceStatusCard({
    required this.isCheckedIn,
    this.checkInTime,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: isCheckedIn
                ? [AppTheme.successGreen, const Color(0xFF43A047)]
                : [AppTheme.warningAmber, const Color(0xFFFFA000)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(
              color:
                  (isCheckedIn ? AppTheme.successGreen : AppTheme.warningAmber)
                      .withValues(alpha: 0.3),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                isCheckedIn ? Icons.check_circle : Icons.radio_button_unchecked,
                color: Colors.white,
                size: 28,
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    isCheckedIn
                        ? s.dashboardCheckedInTitle
                        : s.dashboardNotCheckedInTitle,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  if (checkInTime != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      '${s.dashboardSinceTimePrefix} $checkInTime',
                      style: const TextStyle(
                        color: Colors.white70,
                        fontSize: 13,
                      ),
                    ),
                  ] else
                    Text(
                      s.dashboardTapToManage,
                      style: const TextStyle(
                        color: Colors.white70,
                        fontSize: 13,
                      ),
                    ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: Colors.white),
          ],
        ),
      ),
    );
  }
}

class _SecondaryFeatureTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final String route;

  const _SecondaryFeatureTile({
    required this.icon,
    required this.label,
    required this.color,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      dense: true,
      visualDensity: VisualDensity.compact,
      leading: Container(
        width: 34,
        height: 34,
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(9),
        ),
        child: Icon(icon, color: color, size: 18),
      ),
      title: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: AppTheme.textPrimary,
        ),
      ),
      trailing: Icon(
        Icons.chevron_right,
        color: AppTheme.textSecondary,
        size: 18,
      ),
      onTap: () => context.push(route),
    );
  }
}

class _FeatureButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final String route;

  const _FeatureButton({
    required this.icon,
    required this.label,
    required this.color,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => context.push(route),
      child: Container(
        decoration: BoxDecoration(
          color: AppTheme.cardSurface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppTheme.divider),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.06),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: color, size: 26),
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                label,
                textAlign: TextAlign.center,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w600,
                  color: color,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
