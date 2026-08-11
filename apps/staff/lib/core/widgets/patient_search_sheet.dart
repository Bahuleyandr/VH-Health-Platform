import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../../l10n/app_strings.dart';
import '../config/api_config.dart';
import '../config/role_config.dart';
import '../services/patient_api_service.dart';
import '../theme/app_theme.dart';
import '../utils/patient_identity.dart';

/// Global patient picker — opens as a top-of-screen modal sheet.
///
/// Type a few characters → debounced search hits
/// `GET /api/v1/patients/search?q=…` → tap a row jumps to
/// the role-appropriate patient workspace. Clinical users open the EMR
/// timeline; front-office users keep the selected patient in the workbench.
///
/// Open via [PatientSearchSheet.show] from any screen — typically a
/// magnifier icon in the AppBar or a Cmd+K shortcut.
typedef PatientLookup =
    Future<List<Map<String, dynamic>>> Function(String query);

class PatientSearchSheet extends StatefulWidget {
  final bool pickOnly;
  final PatientLookup? search;

  const PatientSearchSheet({super.key, this.pickOnly = false, this.search});

  /// Boot-time hook (registered in `main.dart`) that opens the one-screen
  /// patient summary (roadmap E5). Lives as an injected callback so this
  /// core widget doesn't import feature code — same pattern as
  /// `CrashReporter.install`. When null, result rows render without the
  /// summary shortcut.
  static void Function(
    BuildContext context, {
    required String patientUid,
    String? patientName,
  })?
  summaryOpener;

  static Future<void> show(BuildContext context) {
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => const Padding(
        padding: EdgeInsets.only(top: 32),
        child: PatientSearchSheet(),
      ),
    );
  }

  static Future<Map<String, dynamic>?> pick(BuildContext context) {
    return showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) => const Padding(
        padding: EdgeInsets.only(top: 32),
        child: PatientSearchSheet(pickOnly: true),
      ),
    );
  }

  @override
  State<PatientSearchSheet> createState() => _PatientSearchSheetState();
}

@visibleForTesting
bool patientSearchShouldOpenFrontOffice(String role) {
  return switch (StaffRole.fromString(role)) {
    StaffRole.receptionist ||
    StaffRole.receptionIncharge ||
    StaffRole.billingStaff ||
    StaffRole.billingIncharge ||
    StaffRole.financeIncharge ||
    StaffRole.admissionOfficer ||
    StaffRole.insuranceCoordinator ||
    StaffRole.ipdCounsellor => true,
    _ => false,
  };
}

@visibleForTesting
String patientSearchOpenRouteForRole(
  String role,
  Map<String, dynamic> patient,
) {
  if (patientSearchShouldOpenFrontOffice(role)) {
    return patientScopedRoute('/front-office', patient: patient);
  }
  final uid = patientUidFrom(patient);
  final name = patientNameFrom(patient);
  return '/emr/timeline/$uid?name=${Uri.encodeQueryComponent(name)}';
}

class _PatientSearchSheetState extends State<PatientSearchSheet> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();
  Timer? _debounce;
  String _lastQuery = '';
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _results = [];

  @override
  void initState() {
    super.initState();
    // Auto-focus the field so the user can start typing immediately.
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _focusNode.requestFocus(),
    );
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    final trimmed = value.trim();
    if (!patientLookupQueryReady(trimmed)) {
      setState(() {
        _results = [];
        _loading = false;
        _error = null;
        _lastQuery = trimmed;
      });
      return;
    }
    _debounce = Timer(
      const Duration(milliseconds: 300),
      () => _runSearch(trimmed),
    );
  }

  Future<void> _runSearch(String query) async {
    if (query == _lastQuery && _loading) return;
    _lastQuery = query;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final lookup = widget.search ?? PatientApiService.search;
      final rows = (await lookup(query))
          .where((patient) => patientMatchesLookupQuery(patient, query))
          .toList(growable: false);
      if (!mounted || query != _lastQuery) return;
      setState(() {
        _results = rows;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || query != _lastQuery) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  Future<void> _openPatient(
    BuildContext context,
    Map<String, dynamic> patient,
  ) async {
    final uid = patientUidFrom(patient);
    if (uid.isEmpty) return;
    if (widget.pickOnly) {
      Navigator.of(context).pop(patient);
      return;
    }
    final role = await ApiConfig.getRole();
    if (!context.mounted) return;
    Navigator.of(context).pop();
    unawaited(context.push(patientSearchOpenRouteForRole(role, patient)));
  }

  @override
  Widget build(BuildContext context) {
    final viewInsets = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: viewInsets),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: MediaQuery.of(context).size.height * 0.7,
          child: Column(
            children: [
              // Drag handle
              Container(
                width: 40,
                height: 4,
                margin: const EdgeInsets.only(top: 8, bottom: 12),
                decoration: BoxDecoration(
                  color: Colors.grey.shade300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),

              // Search input
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: TextField(
                  controller: _controller,
                  focusNode: _focusNode,
                  decoration: InputDecoration(
                    hintText: AppStrings.of(context).lookup(
                      's4.lib.patient_search_sheet.find_a_patient_by_hospital_id_name_phone_or_abha',
                    ),
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.search),
                    ),
                    suffixIcon: _controller.text.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.close),
                            onPressed: () {
                              _controller.clear();
                              _onChanged('');
                            },
                          )
                        : null,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                    filled: true,
                    fillColor: AppTheme.backgroundGrey,
                  ),
                  textInputAction: TextInputAction.search,
                  onChanged: (v) {
                    setState(() {}); // refresh suffixIcon visibility
                    _onChanged(v);
                  },
                  onSubmitted: (v) => _runSearch(v.trim()),
                ),
              ),

              const Divider(height: 1),

              // Results
              Expanded(child: _buildBody()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBody() {
    final strings = AppStrings.of(context);
    if (_controller.text.trim().isEmpty) {
      return _emptyHint(
        Icons.search_outlined,
        strings.lookup('s4.lib.patient_search_sheet.type_to_find_patient'),
      );
    }
    if (!patientLookupQueryReady(_controller.text)) {
      return _emptyHint(
        Icons.search_outlined,
        patientPhoneLikeQuery(_controller.text)
            ? strings.lookup(
                's4.lib.patient_search_sheet.enter_10_digits_for_phone',
              )
            : strings.lookup('s4.lib.patient_search_sheet.type_2_characters'),
      );
    }
    if (_loading && _results.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return _emptyHint(Icons.error_outline, _error!);
    }
    if (_results.isEmpty) {
      return _emptyHint(
        Icons.person_search_outlined,
        strings.format('s4.dynamic.patient_search_sheet.no_matches_for', {
          'query': _lastQuery,
        }),
      );
    }
    return ListView.separated(
      itemCount: _results.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final p = _results[index];
        final name = patientNameFrom(
          p,
          fallback: strings.lookup('s4.lib.patient_search_sheet.unnamed'),
        );
        final subtitle = patientSubtitle(
          p,
          includeAgeGender: true,
          includeAbha: true,
          prefixHospitalId: true,
          separator: ' · ',
        );
        return ListTile(
          leading: CircleAvatar(
            backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.1),
            child: Text(
              name.isNotEmpty ? name[0].toUpperCase() : '?',
              style: const TextStyle(
                color: AppTheme.primaryBlue,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          title: Text(
            name,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: subtitle.isEmpty ? null : Text(subtitle),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // One-tap patient summary (roadmap E5) — opens the
              // allergies/meds/problems/vitals/pending-results sheet
              // WITHOUT leaving the current screen.
              if (!widget.pickOnly && PatientSearchSheet.summaryOpener != null)
                IconButton(
                  tooltip: AppStrings.of(context).summaryTooltip,
                  icon: const Icon(Icons.assignment_ind_outlined),
                  onPressed: () {
                    final uid = patientUidFrom(p);
                    if (uid.isEmpty) return;
                    PatientSearchSheet.summaryOpener!(
                      context,
                      patientUid: uid,
                      patientName: patientNameFrom(p),
                    );
                  },
                ),
              const Icon(Icons.chevron_right),
            ],
          ),
          onTap: () => _openPatient(context, p),
        );
      },
    );
  }

  Widget _emptyHint(IconData icon, String message) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 36, color: AppTheme.textSecondary),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
