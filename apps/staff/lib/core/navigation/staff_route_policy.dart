import '../config/role_config.dart';
import '../config/staff_role_contract.g.dart';
import '../config/ward_indent_role_contract.dart';

enum StaffRouteGate {
  signedIn,
  clinicalEntry,
  patientLookup,
  maternity,
  clinicalCalculators,
  reportAdministration,
  wardIndent,
  marSupplyReconciliation,
  cathInventoryReconciliation,
  platformAdmin,
  counterSaleRefundFinance,
}

class StaffRouteMetadata {
  const StaffRouteMetadata(
    this.template, {
    this.anyFeatureIds = const {},
    this.anyGates = const {},
    this.externalEntry = false,
    this.externalQueryParameters = const {},
  });

  final String template;
  final Set<String> anyFeatureIds;
  final Set<StaffRouteGate> anyGates;
  final bool externalEntry;
  final Set<String> externalQueryParameters;
}

class StaffRouteDecision {
  const StaffRouteDecision._({required this.allowed, required this.reason});

  const StaffRouteDecision.allow() : this._(allowed: true, reason: null);

  const StaffRouteDecision.deny(String reason)
    : this._(allowed: false, reason: reason);

  final bool allowed;
  final String? reason;
}

/// One fail-closed policy table for every Staff router destination.
///
/// The backend remains authoritative for each API call. This client-side gate
/// prevents an unauthorized screen from being constructed while a request is
/// already in flight, and prevents notification payloads from turning into an
/// arbitrary in-app navigation primitive.
class StaffRoutePolicy {
  StaffRoutePolicy._();

  static const _signedIn = {StaffRouteGate.signedIn};
  static const _clinical = {StaffRouteGate.clinicalEntry};

  static const List<StaffRouteMetadata> routes = [
    StaffRouteMetadata('/dashboard', anyGates: _signedIn),
    StaffRouteMetadata('/clinical-continuity', anyGates: _signedIn),
    StaffRouteMetadata(
      '/clinical-continuity/reconciliation',
      anyGates: _signedIn,
    ),
    StaffRouteMetadata(
      '/attendance',
      anyFeatureIds: {'attendance'},
      externalEntry: true,
    ),
    StaffRouteMetadata('/leave', anyFeatureIds: {'leave'}, externalEntry: true),
    StaffRouteMetadata(
      '/appointments',
      anyFeatureIds: {'appointments', 'op_doctor_workspace'},
      externalEntry: true,
      externalQueryParameters: {'date', 'context', 'scope', 'workspace'},
    ),
    StaffRouteMetadata(
      '/teleconsult/appointments/:appointmentId/consult',
      anyFeatureIds: {'op_doctor_workspace'},
    ),
    StaffRouteMetadata(
      '/investigations',
      anyFeatureIds: {'investigations_upload', 'investigation_results'},
      externalEntry: true,
      externalQueryParameters: {
        'context',
        'patient_uid',
        'patient_id',
        'phone',
        'name',
        'hospital_number',
        'appointment_id',
        'doctor_id',
        'doctor_name',
        'department',
        'appointment_date',
        'appointment_time',
      },
    ),
    StaffRouteMetadata('/lab-bookings', anyFeatureIds: {'lab_bookings'}),
    StaffRouteMetadata(
      '/lab/specimen-scan/:investigationId',
      anyFeatureIds: {'investigations_upload', 'lab_bookings'},
    ),
    StaffRouteMetadata(
      '/pharmacy',
      anyFeatureIds: {'pharmacy_orders'},
      anyGates: {StaffRouteGate.wardIndent},
      externalEntry: true,
      externalQueryParameters: {'tab', 'indent_id', 'sale_id'},
    ),
    // Walk-in counter point-of-sale: same holders as the pharmacy workspace
    // (selling is further gated server-side to dispensing roles).
    StaffRouteMetadata(
      '/pharmacy/counter-sale',
      anyFeatureIds: {'pharmacy_orders'},
    ),
    StaffRouteMetadata(
      '/pharmacy/cath-inventory-reconciliation',
      anyGates: {StaffRouteGate.cathInventoryReconciliation},
      externalEntry: true,
      externalQueryParameters: {'case_id', 'consumable_usage_id'},
    ),
    StaffRouteMetadata('/profile', anyFeatureIds: {'profile'}),
    StaffRouteMetadata('/settings', anyFeatureIds: {'settings'}),
    StaffRouteMetadata('/phone/more', anyGates: _signedIn),
    StaffRouteMetadata('/phone/queries', anyGates: _signedIn),
    StaffRouteMetadata(
      '/phone/patient-lookup',
      anyGates: {StaffRouteGate.patientLookup},
    ),
    StaffRouteMetadata(
      '/front-office',
      anyFeatureIds: {'front_office_workbench'},
    ),
    StaffRouteMetadata('/billing-desk', anyFeatureIds: {'billing_desk'}),
    StaffRouteMetadata(
      '/billing/refunds',
      anyGates: {StaffRouteGate.counterSaleRefundFinance},
      externalEntry: true,
      externalQueryParameters: {'refund_id', 'void_request_id'},
    ),
    StaffRouteMetadata(
      '/billing/gateway-refund-reconciliation',
      anyGates: {StaffRouteGate.platformAdmin},
      externalEntry: true,
      externalQueryParameters: {'refund_id'},
    ),
    StaffRouteMetadata(
      '/billing/credit-notes',
      anyFeatureIds: {'billing_desk'},
      externalEntry: true,
    ),
    StaffRouteMetadata(
      '/billing/credit-notes/:id',
      anyFeatureIds: {'billing_desk'},
      externalEntry: true,
    ),
    StaffRouteMetadata('/ward-mode', anyFeatureIds: {'ward_mode'}),
    StaffRouteMetadata('/ed-trauma', anyFeatureIds: {'ed_trauma_workbench'}),
    // Ambulance live tracking: ED workbench holders (live view) plus the
    // SOS-responder roster, which carries DRIVER — the crew role that posts
    // positions. Mirrors backend AMBULANCE_TRACKING_ROUTE_ROLES.
    StaffRouteMetadata(
      '/ambulance-tracking',
      anyFeatureIds: {'ed_trauma_workbench', 'sos_response'},
    ),
    StaffRouteMetadata('/patient-records', anyFeatureIds: {'patient_records'}),
    StaffRouteMetadata('/prescriptions', anyFeatureIds: {'prescriptions'}),
    StaffRouteMetadata(
      '/op/doctor-workspace/:uid',
      anyFeatureIds: {'op_doctor_workspace'},
    ),
    StaffRouteMetadata(
      '/op/nursing-dashboard',
      anyFeatureIds: {'op_nursing_dashboard'},
    ),
    StaffRouteMetadata('/queue', anyFeatureIds: {'queue'}),
    StaffRouteMetadata(
      '/appointment-queue',
      anyFeatureIds: {'front_office_workbench'},
    ),
    StaffRouteMetadata(
      '/clinical-ai/queue',
      anyFeatureIds: {'clinical_ai_review_queue'},
    ),
    StaffRouteMetadata(
      '/clinical-inbox',
      anyFeatureIds: {'clinical_inbox'},
      externalEntry: true,
    ),
    StaffRouteMetadata(
      '/clinical-inbox/recovery',
      anyGates: {StaffRouteGate.platformAdmin},
      externalEntry: true,
      externalQueryParameters: {'case_id'},
    ),
    StaffRouteMetadata(
      '/clinical-ai/review/:reviewId',
      anyFeatureIds: {'clinical_ai_review_queue'},
    ),
    StaffRouteMetadata(
      '/clinical-ai/compose',
      anyFeatureIds: {'clinical_ai_review_queue'},
    ),
    StaffRouteMetadata(
      '/clinical-ai/compose/:runId',
      anyFeatureIds: {'clinical_ai_review_queue'},
    ),
    StaffRouteMetadata(
      '/clinical-ai/voice-notes',
      anyFeatureIds: {'clinical_ai_review_queue'},
    ),
    StaffRouteMetadata('/op-ai-assist', anyFeatureIds: {'op_ai_assist'}),
    StaffRouteMetadata('/vitals', anyGates: _clinical),
    StaffRouteMetadata('/nursing-notes', anyGates: _clinical),
    StaffRouteMetadata(
      '/mar/due',
      anyGates: _clinical,
      externalEntry: true,
      externalQueryParameters: {'exception_id'},
    ),
    StaffRouteMetadata('/mar/scan/:maId', anyGates: _clinical),
    StaffRouteMetadata(
      '/mar/reconcile/:maId',
      anyGates: {StaffRouteGate.marSupplyReconciliation},
      externalEntry: true,
    ),
    StaffRouteMetadata(
      '/devices/associate',
      anyFeatureIds: {'device_association'},
    ),
    StaffRouteMetadata('/drug-chart/:admissionId', anyGates: _clinical),
    StaffRouteMetadata(
      '/referrals',
      anyFeatureIds: {'referrals'},
      externalEntry: true,
    ),
    StaffRouteMetadata(
      '/referrals/request/:admissionId',
      anyFeatureIds: {'referrals'},
    ),
    StaffRouteMetadata('/hr-dashboard', anyFeatureIds: {'hr_dashboard'}),
    StaffRouteMetadata(
      '/staff-management',
      anyFeatureIds: {'staff_management'},
    ),
    StaffRouteMetadata(
      '/organization-hierarchy',
      anyFeatureIds: {'organization_hierarchy'},
    ),
    StaffRouteMetadata('/performance', anyFeatureIds: {'performance'}),
    StaffRouteMetadata('/leave-approvals', anyFeatureIds: {'leave_approvals'}),
    StaffRouteMetadata('/staff-rosters', anyFeatureIds: {'staff_roster'}),
    StaffRouteMetadata(
      '/reports-grievances',
      anyFeatureIds: {'reports_grievances'},
    ),
    StaffRouteMetadata(
      '/reports-grievances/admin',
      anyGates: {StaffRouteGate.reportAdministration},
    ),
    StaffRouteMetadata('/payroll', anyFeatureIds: {'payroll'}),
    StaffRouteMetadata('/payroll/payslips/:id', anyFeatureIds: {'payroll'}),
    StaffRouteMetadata('/payroll/queries', anyFeatureIds: {'payroll'}),
    StaffRouteMetadata('/payroll/declarations', anyFeatureIds: {'payroll'}),
    StaffRouteMetadata('/payroll/tax-summary', anyFeatureIds: {'payroll'}),
    StaffRouteMetadata(
      '/housekeeping-tasks',
      anyFeatureIds: {'housekeeping_tasks'},
      externalEntry: true,
    ),
    StaffRouteMetadata('/housekeeping', anyFeatureIds: {'housekeeping_hub'}),
    StaffRouteMetadata(
      '/housekeeping-command',
      anyFeatureIds: {'housekeeping_command'},
    ),
    StaffRouteMetadata(
      '/housekeeping-roster',
      anyFeatureIds: {'housekeeping_roster'},
    ),
    StaffRouteMetadata(
      '/biomed-work-orders',
      anyFeatureIds: {'biomed_work_orders'},
    ),
    StaffRouteMetadata(
      '/staff-roster/:department',
      anyFeatureIds: {
        'staff_roster',
        'nursing_roster',
        'op_nursing_roster',
        'reception_roster',
        'maintenance_roster',
        'pharmacy_roster',
        'housekeeping_roster',
      },
    ),
    StaffRouteMetadata('/staff-directory', anyFeatureIds: {'staff_directory'}),
    StaffRouteMetadata('/schedule', anyFeatureIds: {'schedule'}),
    StaffRouteMetadata('/duty-preference', anyFeatureIds: {'duty_preference'}),
    // Shift swaps + on-call: reached from the schedule screen's shift
    // actions; backend enforces per-department swap/on-call authority.
    StaffRouteMetadata(
      '/shift-swaps',
      anyFeatureIds: {'schedule', 'duty_preference'},
    ),
    StaffRouteMetadata(
      '/handover',
      anyFeatureIds: {'handover'},
      externalEntry: true,
      externalQueryParameters: {'patient_ref', 'phone'},
    ),
    StaffRouteMetadata(
      '/notifications',
      anyGates: _signedIn,
      externalEntry: true,
    ),
    StaffRouteMetadata(
      '/safety-center',
      anyFeatureIds: {'safety_center'},
      externalEntry: true,
    ),
    // Resus documentation mirrors the backend requireStaffOrAdmin gate on
    // /resuscitation/events/* — any staff role may open the record, so the
    // all-staff safety_center feature grants entry alongside clinical entry.
    StaffRouteMetadata(
      '/safety/resus/:eventId',
      anyFeatureIds: {'safety_center'},
      anyGates: _clinical,
    ),
    // SOS responder loop mirrors backend emergencyResponderRoutes RBAC
    // (rbacConfig.js): EMERGENCY_RESPONDER, SECURITY, DRIVER, ADMIN, CMO,
    // MEDICAL_SUPERINTENDENT (+ SUPER_ADMIN via requireRole's bypass) — the
    // generated sos_response contract group pins the exact roster.
    // externalEntry lets the EMERGENCY push notification deep-link here.
    StaffRouteMetadata(
      '/sos-response',
      anyFeatureIds: {'sos_response'},
      externalEntry: true,
    ),
    StaffRouteMetadata(
      '/sos-response/:alertId',
      anyFeatureIds: {'sos_response'},
      externalEntry: true,
    ),
    StaffRouteMetadata('/audit-logs', anyFeatureIds: {'audit_logs'}),
    StaffRouteMetadata(
      '/staff-diagnostics',
      anyFeatureIds: {'staff_diagnostics'},
    ),
    StaffRouteMetadata('/about', anyGates: _signedIn),
    StaffRouteMetadata(
      '/messaging',
      anyFeatureIds: {'messaging'},
      externalEntry: true,
    ),
    StaffRouteMetadata(
      '/messaging/thread/:otherStaffUid',
      anyFeatureIds: {'messaging'},
    ),
    StaffRouteMetadata(
      '/beds',
      anyFeatureIds: {'bed_board'},
      externalEntry: true,
    ),
    StaffRouteMetadata('/blood-bank', anyFeatureIds: {'blood_bank'}),
    StaffRouteMetadata(
      '/blood-bank/scan/:requestId',
      anyFeatureIds: {'blood_bank'},
    ),
    StaffRouteMetadata('/dietary', anyFeatureIds: {'dietary'}),
    // Kitchen board + ward tray tracking: kitchen staff via the dietary
    // feature; ward staff reach the tray leg via the IP command-board
    // feature (backend gates kitchen-phase transitions to dietary roles).
    StaffRouteMetadata(
      '/dietary/kitchen',
      anyFeatureIds: {'dietary', 'patient_command_board'},
    ),
    StaffRouteMetadata('/dental', anyFeatureIds: {'dental_charting'}),
    StaffRouteMetadata('/med-rec', anyFeatureIds: {'med_rec'}),
    StaffRouteMetadata('/transport', anyFeatureIds: {'patient_transport'}),
    StaffRouteMetadata(
      '/scheduling-workbench',
      anyFeatureIds: {'scheduling_workbench'},
    ),
    StaffRouteMetadata('/perfusion', anyFeatureIds: {'perfusion'}),
    StaffRouteMetadata('/physiotherapy', anyFeatureIds: {'physiotherapy'}),
    StaffRouteMetadata('/transplant', anyFeatureIds: {'transplant_program'}),
    StaffRouteMetadata('/theatre', anyFeatureIds: {'theatre'}),
    StaffRouteMetadata('/cath-lab', anyFeatureIds: {'cath_lab'}),
    StaffRouteMetadata(
      '/radiation-oncology',
      anyFeatureIds: {'radiation_oncology'},
    ),
    StaffRouteMetadata('/oncology', anyFeatureIds: {'oncology'}),
    StaffRouteMetadata(
      '/calculators',
      anyGates: {StaffRouteGate.clinicalCalculators},
    ),
    StaffRouteMetadata('/maternity', anyGates: {StaffRouteGate.maternity}),
    StaffRouteMetadata(
      '/maternity/partograph/:laborId',
      anyGates: {StaffRouteGate.maternity},
    ),
    StaffRouteMetadata(
      '/maternity/labor/:laborId/chart',
      anyGates: {StaffRouteGate.maternity},
    ),
    StaffRouteMetadata('/ophthalmology', anyFeatureIds: {'ophthalmology'}),
    StaffRouteMetadata('/radiology', anyFeatureIds: {'radiology'}),
    StaffRouteMetadata('/stroke-pathway', anyFeatureIds: {'stroke_pathway'}),
    StaffRouteMetadata(
      '/patient-command-board',
      anyFeatureIds: {'patient_command_board'},
      externalEntry: true,
    ),
    StaffRouteMetadata(
      '/emr/admissions',
      anyFeatureIds: {'admissions'},
      anyGates: _clinical,
      externalEntry: true,
    ),
    StaffRouteMetadata('/emr/case-sheet/:id', anyGates: _clinical),
    StaffRouteMetadata('/emr/notes/:uid', anyGates: _clinical),
    StaffRouteMetadata('/emr/timeline/:uid', anyGates: _clinical),
    StaffRouteMetadata(
      '/emr/orders/:uid',
      anyGates: _clinical,
      externalEntry: true,
      externalQueryParameters: {'mar_recovery_order', 'icu_mar_review'},
    ),
    StaffRouteMetadata('/emr/orders/:uid/compose', anyGates: _clinical),
    StaffRouteMetadata('/emr/vitals/:uid', anyGates: _clinical),
    StaffRouteMetadata('/emr/burns/:uid', anyGates: _clinical),
    StaffRouteMetadata('/emr/discharge-hub', anyFeatureIds: {'discharge_hub'}),
    StaffRouteMetadata(
      '/emr/discharge-hub/:id',
      anyFeatureIds: {'discharge_hub'},
    ),
    StaffRouteMetadata('/emr/discharge/:id', anyFeatureIds: {'discharge_hub'}),
  ];

  static StaffRouteDecision authorize(Uri uri, {required String rawRole}) {
    final metadata = metadataForPath(uri.path);
    if (metadata == null) {
      return const StaffRouteDecision.deny('unknown_route');
    }

    final role = StaffRole.tryFromString(rawRole);
    if (role == null) {
      return const StaffRouteDecision.deny('unknown_role');
    }

    final normalized = rawRole.trim().toUpperCase();
    final isCanonical = canonicalStaffRoleCodes.contains(normalized);
    final featureAllowed = isCanonical
        ? metadata.anyFeatureIds.any(
            (featureId) =>
                canonicalStaffFeatureRouteRoleCodes[featureId]?.contains(
                  normalized,
                ) ??
                false,
          )
        : metadata.anyFeatureIds.any(
            RoleFeatures.getFeaturesForRole(role)
                .map((feature) => feature.id)
                .toSet()
                .contains,
          );
    if (featureAllowed) {
      return const StaffRouteDecision.allow();
    }
    if (metadata.anyGates.any((gate) => _allowsGate(gate, rawRole, role))) {
      return const StaffRouteDecision.allow();
    }
    return const StaffRouteDecision.deny('capability_denied');
  }

  static StaffRouteMetadata? metadataForPath(String path) {
    for (final metadata in routes) {
      if (_matchesTemplate(metadata.template, path)) return metadata;
    }
    return null;
  }

  static bool hasMetadataForTemplate(String template) =>
      routes.any((metadata) => metadata.template == template);

  static String? sanitizeExternalRoute(String? candidate) {
    if (candidate == null) return null;
    var raw = candidate.trim();
    if (raw.isEmpty || raw.length > 2048) return null;
    if (raw.startsWith('//') || raw.contains('\\')) return null;
    if (raw.codeUnits.any((unit) => unit < 0x20 || unit == 0x7f)) return null;
    final lower = raw.toLowerCase();
    if (lower.contains('%2f') ||
        lower.contains('%5c') ||
        lower.contains('%2e')) {
      return null;
    }

    raw = _normalizeLegacyRoute(raw);
    final uri = Uri.tryParse(raw);
    if (uri == null ||
        uri.hasScheme ||
        uri.hasAuthority ||
        uri.fragment.isNotEmpty ||
        !uri.path.startsWith('/')) {
      return null;
    }
    if (uri.pathSegments.any((segment) => segment == '.' || segment == '..')) {
      return null;
    }
    if (uri.pathSegments.any(_containsControlCharacter)) return null;

    final metadata = metadataForPath(uri.path);
    if (metadata == null || !metadata.externalEntry) return null;
    for (final entry in uri.queryParametersAll.entries) {
      if (!metadata.externalQueryParameters.contains(entry.key) ||
          _containsControlCharacter(entry.key) ||
          entry.value.length != 1 ||
          entry.value.single.isEmpty ||
          entry.value.single.length > 256 ||
          _containsControlCharacter(entry.value.single)) {
        return null;
      }
    }
    if (uri.path == '/pharmacy' && uri.queryParameters.isNotEmpty) {
      final tab = uri.queryParameters['tab'];
      final rawIndentId = uri.queryParameters['indent_id'];
      final rawSaleId = uri.queryParameters['sale_id'];
      if (tab == 'ward-indents') {
        if (rawSaleId != null) return null;
        if (rawIndentId != null &&
            !_isCanonicalPositivePostgresInteger(rawIndentId)) {
          return null;
        }
      } else if (tab == 'counter-sales') {
        if (rawIndentId != null ||
            rawSaleId == null ||
            !_isCanonicalPositiveBigInt(rawSaleId)) {
          return null;
        }
      } else {
        return null;
      }
    }
    if (uri.path == '/billing/refunds') {
      final refundId = uri.queryParameters['refund_id'];
      final voidRequestId = uri.queryParameters['void_request_id'];
      if (refundId == null ||
          !_isCanonicalPositivePostgresInteger(refundId) ||
          (voidRequestId != null &&
              !_isCanonicalPositiveBigInt(voidRequestId))) {
        return null;
      }
    }
    if (uri.path == '/billing/gateway-refund-reconciliation') {
      final refundId = uri.queryParameters['refund_id'];
      if (refundId != null && !_isCanonicalPositivePostgresInteger(refundId)) {
        return null;
      }
    }
    if (uri.path == '/pharmacy/cath-inventory-reconciliation') {
      final caseId = uri.queryParameters['case_id'];
      final usageId = uri.queryParameters['consumable_usage_id'];
      if (caseId == null ||
          usageId == null ||
          !_isCanonicalPositiveBigInt(caseId) ||
          !_isCanonicalPositiveBigInt(usageId)) {
        return null;
      }
    }
    if (uri.path.startsWith('/mar/reconcile/')) {
      final maId = uri.pathSegments.last;
      if (!_isCanonicalPositivePostgresInteger(maId) ||
          uri.queryParameters.isNotEmpty) {
        return null;
      }
    }
    if (uri.path == '/mar/due') {
      final exceptionId = uri.queryParameters['exception_id'];
      if (exceptionId != null && !_isCanonicalPositiveBigInt(exceptionId)) {
        return null;
      }
    }
    if (uri.path == '/clinical-inbox/recovery') {
      final caseId = uri.queryParameters['case_id'];
      if (caseId != null && !_isCanonicalPositiveBigInt(caseId)) {
        return null;
      }
    }
    if (uri.path.startsWith('/emr/orders/')) {
      final uid = uri.pathSegments.length == 3 ? uri.pathSegments.last : '';
      if (!_uuidPattern.hasMatch(uid)) return null;
      final recoveryOrder = uri.queryParameters['mar_recovery_order'];
      final icuMarReview = uri.queryParameters['icu_mar_review'];
      if ((recoveryOrder == null) == (icuMarReview == null)) return null;
      final workflowId = recoveryOrder ?? icuMarReview!;
      if (!_positiveIntegerPattern.hasMatch(workflowId) ||
          int.tryParse(workflowId) == null) {
        return null;
      }
    }
    if (uri.pathSegments.length == 3 &&
        uri.pathSegments[0] == 'billing' &&
        uri.pathSegments[1] == 'credit-notes' &&
        (!_isCanonicalPositiveBigInt(uri.pathSegments[2]) ||
            uri.queryParameters.isNotEmpty)) {
      return null;
    }
    return uri.toString();
  }

  static bool _allowsGate(StaffRouteGate gate, String rawRole, StaffRole role) {
    final normalized = rawRole.trim().toUpperCase();
    final isCanonical = canonicalStaffRoleCodes.contains(normalized);
    return switch (gate) {
      StaffRouteGate.signedIn => true,
      StaffRouteGate.clinicalEntry =>
        isCanonical
            ? canonicalClinicalStaffRouteRoleCodes.contains(normalized)
            : RoleFeatures.hasClinicalEntry(role),
      StaffRouteGate.patientLookup =>
        isCanonical
            ? canonicalPatientLookupRouteRoleCodes.contains(normalized)
            : RoleFeatures.hasPatientLookup(role),
      StaffRouteGate.maternity =>
        isCanonical
            ? canonicalMaternityRouteRoleCodes.contains(normalized)
            : RoleFeatures.hasMaternity(role),
      StaffRouteGate.clinicalCalculators =>
        isCanonical
            ? canonicalClinicalDocumentRouteRoleCodes.contains(normalized)
            : RoleFeatures.hasClinicalCalculators(role),
      StaffRouteGate.reportAdministration =>
        isCanonical
            ? canonicalPeopleOperationsRouteRoleCodes.contains(normalized)
            : role.isAdminTier || role == StaffRole.hr,
      StaffRouteGate.wardIndent => WardIndentRoleContract.canRead(
        rawRole: rawRole,
        role: role,
      ),
      StaffRouteGate.marSupplyReconciliation => const {
        'ADMIN',
        'SUPER_ADMIN',
        'PHARMACY_INCHARGE',
        'NURSING_INCHARGE',
        'IP_INCHARGE',
      }.contains(normalized),
      StaffRouteGate.cathInventoryReconciliation => const {
        'PHARMACIST',
        'PHARMACY_STAFF',
        'PHARMACY_INCHARGE',
        'ADMIN',
        'SUPER_ADMIN',
      }.contains(normalized),
      StaffRouteGate.platformAdmin => const {
        'ADMIN',
        'SUPER_ADMIN',
      }.contains(normalized),
      StaffRouteGate.counterSaleRefundFinance => const {
        'ADMIN',
        'SUPER_ADMIN',
        'FINANCE_INCHARGE',
        'BILLING_INCHARGE',
        'BILLING_STAFF',
        'CASHIER',
      }.contains(normalized),
    };
  }

  static bool _matchesTemplate(String template, String path) {
    final templateParts = Uri(path: template).pathSegments;
    final pathParts = Uri(path: path).pathSegments;
    if (templateParts.length != pathParts.length) return false;
    for (var index = 0; index < templateParts.length; index += 1) {
      final expected = templateParts[index];
      final actual = pathParts[index];
      if (expected.startsWith(':')) {
        if (actual.isEmpty) return false;
      } else if (expected != actual) {
        return false;
      }
    }
    return true;
  }

  static String _normalizeLegacyRoute(String route) {
    if (route == '/admissions') return '/emr/admissions';
    if (route.startsWith('/admissions?')) {
      return route.replaceFirst('/admissions', '/emr/admissions');
    }
    if (route == '/housekeeping') return '/housekeeping-tasks';
    final uri = Uri.tryParse(route);
    if (uri != null &&
        uri.pathSegments.length == 3 &&
        uri.pathSegments[0] == 'clinical' &&
        uri.pathSegments[1] == 'mar' &&
        uri.queryParameters.length == 1 &&
        uri.queryParameters['supply-reconciliation'] == '1') {
      final maId = uri.pathSegments[2];
      if (_isCanonicalPositivePostgresInteger(maId)) {
        return '/mar/reconcile/$maId';
      }
    }
    return route;
  }

  static final RegExp _uuidPattern = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false,
  );
  static final RegExp _positiveIntegerPattern = RegExp(r'^[1-9][0-9]*$');
  static const String _maximumSignedBigInt = '9223372036854775807';
  static const String _maximumPostgresInteger = '2147483647';

  static bool _isCanonicalPositivePostgresInteger(String value) =>
      _positiveIntegerPattern.hasMatch(value) &&
      value.length <= _maximumPostgresInteger.length &&
      (value.length < _maximumPostgresInteger.length ||
          value.compareTo(_maximumPostgresInteger) <= 0);

  static bool _isCanonicalPositiveBigInt(String value) =>
      _positiveIntegerPattern.hasMatch(value) &&
      value.length <= _maximumSignedBigInt.length &&
      (value.length < _maximumSignedBigInt.length ||
          value.compareTo(_maximumSignedBigInt) <= 0);

  static bool _containsControlCharacter(String value) =>
      value.codeUnits.any((unit) => unit < 0x20 || unit == 0x7f);
}
