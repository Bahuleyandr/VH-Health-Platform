import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../../core/config/api_config.dart';
import '../../../core/config/role_config.dart';
import '../../../core/platform_info.dart';
import '../../../core/services/billing_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/utils/patient_identity.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../../teleconsult/models/staff_teleconsult_models.dart';
import '../../teleconsult/widgets/staff_teleconsult_badge.dart';
import '../widgets/billing_collect_button.dart';
import '../widgets/billing_document_actions.dart';
import '../widgets/billing_payment_dialog.dart';

part 'components/front_office_workbench_helpers.dart';
part 'components/front_office_workbench_actions.dart';
part 'components/front_office_workbench_patient_dialogs.dart';
part 'components/front_office_workbench_walk_in_dialog.dart';
part 'components/front_office_workbench_admission_dialogs.dart';
part 'components/front_office_workbench_queue_dialogs.dart';
part 'components/front_office_workbench_sections.dart';
part 'components/front_office_workbench_widgets.dart';

class FrontOfficeWorkbenchScreen extends StatefulWidget {
  final String? initialPatientUid;
  final String? initialPatientId;
  final String? initialPatientName;
  final String? initialPatientPhone;
  final String? initialHospitalNumber;

  const FrontOfficeWorkbenchScreen({
    super.key,
    this.initialPatientUid,
    this.initialPatientId,
    this.initialPatientName,
    this.initialPatientPhone,
    this.initialHospitalNumber,
  });

  @override
  State<FrontOfficeWorkbenchScreen> createState() =>
      _FrontOfficeWorkbenchScreenState();
}

class _FrontOfficeWorkbenchScreenState
    extends State<FrontOfficeWorkbenchScreen> {
  final _searchCtrl = TextEditingController();
  final _searchFocus = FocusNode();
  final _scrollController = ScrollController();
  final _patientPanelKey = GlobalKey();
  final _queuePanelKey = GlobalKey();
  final _billingPanelKey = GlobalKey();
  final _admissionsPanelKey = GlobalKey();
  Timer? _searchDebounce;
  Future<List<Map<String, dynamic>>>? _doctorsFuture;
  Future<List<Map<String, dynamic>>>? _wardsFuture;

  StaffRole _role = StaffRole.general;
  bool _roleLoaded = false;
  bool _loading = true;
  bool _lookupBusy = false;
  bool _invoiceBusy = false;
  bool _billingActionBusy = false;
  bool _admissionActionBusy = false;
  bool _worklistsLoadInFlight = false;
  AppDeviceMode? _worklistsLoadedForMode;
  int? _queueActionId;
  String? _error;
  String? _lookupError;
  DateTime _queueDate = _dateOnly(DateTime.now());

  List<Map<String, dynamic>> _patientMatches = const [];
  Map<String, dynamic>? _selectedPatient;
  List<Map<String, dynamic>> _todayQueue = const [];
  List<Map<String, dynamic>> _admissionHandoffs = const [];
  List<Map<String, dynamic>> _activeAdmissions = const [];
  int _activeAdmissionsTotal = 0;
  List<Map<String, dynamic>> _patientInvoices = const [];

  static const _admissionPriorities = [
    'Routine',
    'Urgent',
    'Emergency',
    'Critical',
  ];
  static const _codeStatuses = ['Full Code', 'DNR', 'DNR/DNI', 'Comfort Care'];

  FrontOfficeQueueScope get _queueScope => frontOfficeQueueScopeForRole(_role);
  bool get _canBookOp => frontOfficeCanBookOp(_role);
  bool get _canBilling => RoleFeatures.hasBillingDesk(_role);
  bool get _canClinical => RoleFeatures.hasClinicalEntry(_role);
  bool get _canManageOpQueue => frontOfficeCanManageAppointmentQueue(_role);
  bool get _canCompleteOpQueue => frontOfficeCanCompleteAppointment(_role);
  bool get _canPatientLookup => RoleFeatures.hasPatientLookup(_role);
  bool get _canPatientRegistryCreate =>
      RoleFeatures.hasPatientRegistryCreate(_role);
  bool get _canPatientRegistryWrite =>
      RoleFeatures.hasPatientRegistryWrite(_role);
  bool get _canViewAdmissionHandoffs => _canAdmitIp;
  bool get _canAdmitIp => RoleFeatures.hasIpAdmissionAccess(_role);

  @override
  void initState() {
    super.initState();
    _loadInitialState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _canPatientLookup) _searchFocus.requestFocus();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_roleLoaded) {
      unawaited(_requestWorklistsForMode(appDeviceModeForContext(context)));
    }
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _searchFocus.dispose();
    _scrollController.dispose();
    _searchCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final mode = appDeviceModeForContext(context);
    final s = AppStrings.of(context);
    if (!_roleLoaded) {
      return StaffScaffold(
        title: s.lookup('role.feature.front_office_workbench'),
        body: const SkeletonList(),
      );
    }

    if (!RoleFeatures.hasFrontOfficeWorkbench(_role)) {
      return StaffScaffold(
        title: s.lookup('role.feature.front_office_workbench'),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildUnavailablePanel(
              icon: Icons.lock_outline,
              title: s.lookup(
                's4.lib.front_office_workbench.front_office_unavailable',
              ),
              message: s.format(
                's4.dynamic.front_office.not_enabled_for_role',
                {'role': s.lookup(_role.displayNameKey)},
              ),
            ),
          ],
        ),
      );
    }

    if (!mode.isWorkbench) {
      return StaffScaffold(
        title: s.lookup('role.feature.front_office_workbench'),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _buildUnavailablePanel(
              icon: Icons.devices_outlined,
              title: s.lookup(
                's4.lib.front_office_workbench.workstation_mode_required',
              ),
              message: s.lookup(
                's4.lib.front_office_workbench.workstation_mode_required_message',
              ),
              actions: [
                _ActionTile(
                  icon: Icons.schedule_outlined,
                  label: s.lookup('role.feature.schedule'),
                  color: AppTheme.primaryTeal,
                  onTap: () => context.push('/schedule'),
                ),
                _ActionTile(
                  icon: Icons.event_available_outlined,
                  label: s.lookup('role.feature.leave'),
                  color: AppTheme.primaryBlue,
                  onTap: () => context.push('/leave'),
                ),
                _ActionTile(
                  icon: Icons.person_outline,
                  label: s.lookup('role.feature.profile'),
                  color: AppTheme.warningAmber,
                  onTap: () => context.push('/profile'),
                ),
              ],
            ),
          ],
        ),
      );
    }

    return StaffScaffold(
      title: s.lookup('s4.lib.front_office_workbench.front_office_workbench'),
      body: RefreshIndicator(
        onRefresh: _refreshWorklists,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth >= 980;
            final showInitialSkeleton =
                _loading &&
                _selectedPatient == null &&
                _patientMatches.isEmpty &&
                _todayQueue.isEmpty &&
                _patientInvoices.isEmpty &&
                _admissionHandoffs.isEmpty &&
                _activeAdmissions.isEmpty;
            return ListView(
              controller: _scrollController,
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
              children: [
                _buildHeader(mode),
                const SizedBox(height: 12),
                if (_error != null)
                  _InlineAlert(message: _error!, color: AppTheme.errorRed),
                if (_selectedPatient != null) ...[
                  _buildPatientContextStrip(_selectedPatient!),
                  const SizedBox(height: 12),
                ],
                if (_loading) const LinearProgressIndicator(minHeight: 2),
                if (showInitialSkeleton)
                  const SizedBox(
                    height: 520,
                    child: SkeletonList(itemCount: 5, itemHeight: 92),
                  )
                else if (wide)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 5,
                        child: Column(
                          children: [
                            KeyedSubtree(
                              key: _patientPanelKey,
                              child: _buildPatientPanel(),
                            ),
                            const SizedBox(height: 12),
                            _buildActionPanel(),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 4,
                        child: Column(
                          children: [
                            KeyedSubtree(
                              key: _queuePanelKey,
                              child: _buildQueuePanel(),
                            ),
                            const SizedBox(height: 12),
                            KeyedSubtree(
                              key: _billingPanelKey,
                              child: _buildBillingPanel(),
                            ),
                            const SizedBox(height: 12),
                            KeyedSubtree(
                              key: _admissionsPanelKey,
                              child: _buildAdmissionsPanel(),
                            ),
                          ],
                        ),
                      ),
                    ],
                  )
                else ...[
                  KeyedSubtree(
                    key: _patientPanelKey,
                    child: _buildPatientPanel(),
                  ),
                  const SizedBox(height: 12),
                  _buildActionPanel(),
                  const SizedBox(height: 12),
                  KeyedSubtree(key: _queuePanelKey, child: _buildQueuePanel()),
                  const SizedBox(height: 12),
                  KeyedSubtree(
                    key: _billingPanelKey,
                    child: _buildBillingPanel(),
                  ),
                  const SizedBox(height: 12),
                  KeyedSubtree(
                    key: _admissionsPanelKey,
                    child: _buildAdmissionsPanel(),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}
