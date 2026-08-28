import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/mar_offline_cache.dart';

import '../../../core/services/auth_service.dart';
import '../../../core/services/idempotency_attempt_registry.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/skeleton_list.dart';
import '../../../l10n/app_strings.dart';
import '../../../core/widgets/ward_list_filter_bar.dart';

const String _dueMedsAllWards = '';
const String _dueMedsAllRoutes = 'all';
const String _maximumSignedBigInt = '9223372036854775807';
final RegExp _positiveBigIntPattern = RegExp(r'^[1-9][0-9]*$');

bool _isCanonicalPositiveBigInt(String value) =>
    _positiveBigIntPattern.hasMatch(value) &&
    value.length <= _maximumSignedBigInt.length &&
    (value.length < _maximumSignedBigInt.length ||
        value.compareTo(_maximumSignedBigInt) <= 0);

enum MarDueTransition { miss, hold, releaseHold, reviewException }

class MarExceptionDisposition {
  const MarExceptionDisposition({
    required this.code,
    required this.reason,
    this.replacementClinicalOrderId,
  });

  final String code;
  final String reason;
  final int? replacementClinicalOrderId;
}

class _MarExceptionPromptResult {
  const _MarExceptionPromptResult.disposition(this.disposition)
    : createOrder = false;

  const _MarExceptionPromptResult.createOrder()
    : disposition = null,
      createOrder = true;

  final MarExceptionDisposition? disposition;
  final bool createOrder;
}

@visibleForTesting
const Set<String> marHoldReleaseRoleCodes = {
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
};

bool canReleaseHeldMarDose(String? role) =>
    marHoldReleaseRoleCodes.contains(role?.trim().toUpperCase() ?? '');

List<MarDueTransition> availableMarDueTransitions(
  Map<String, dynamic> row, {
  bool canReleaseHold = false,
  bool canReviewException = false,
}) {
  final hasExceptionCase =
      _isCanonicalPositiveBigInt(_filterText(row['exception_case_id']));
  final orderIsActive = const {
    'ordered',
    'verified',
    'in_progress',
  }.contains(_filterText(row['clinical_order_status']).toLowerCase());
  return switch (_filterText(row['status']).toLowerCase()) {
    'scheduled' => const [MarDueTransition.miss, MarDueTransition.hold],
    'held' when canReleaseHold && orderIsActive => const [
      MarDueTransition.releaseHold,
    ],
    'held' when canReviewException && hasExceptionCase => const [
      MarDueTransition.reviewException,
    ],
    'missed' when canReviewException && hasExceptionCase => const [
      MarDueTransition.reviewException,
    ],
    _ => const [],
  };
}

bool canOpenMarScanner(Map<String, dynamic> row) =>
    _filterText(row['status']).toLowerCase() == 'scheduled';

List<WardListFilterOption> dueMedsWardFilterOptions(
  List<Map<String, dynamic>> rows, {
  required String allWardsLabel,
  required String Function(String value) wardFallbackLabel,
}) {
  final byValue = <String, String>{};
  for (final row in rows) {
    final value = _filterText(row['ward_id']);
    if (value.isEmpty) continue;
    byValue.putIfAbsent(value, () {
      final label = _filterText(row['ward_name']);
      return label.isEmpty ? wardFallbackLabel(value) : label;
    });
  }
  final options = byValue.entries.toList()
    ..sort((a, b) => a.value.toLowerCase().compareTo(b.value.toLowerCase()));
  return [
    WardListFilterOption(value: _dueMedsAllWards, label: allWardsLabel),
    for (final entry in options)
      WardListFilterOption(value: entry.key, label: entry.value),
  ];
}

List<WardListFilterOption> dueMedsRouteFilterOptions(
  List<Map<String, dynamic>> rows, {
  required String allRoutesLabel,
}) {
  final routes =
      rows
          .map((row) => _filterText(row['route']))
          .where((route) => route.isNotEmpty)
          .toSet()
          .toList()
        ..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
  return [
    WardListFilterOption(value: _dueMedsAllRoutes, label: allRoutesLabel),
    for (final route in routes)
      WardListFilterOption(value: route, label: route),
  ];
}

List<Map<String, dynamic>> filterDueMedicationRows(
  List<Map<String, dynamic>> rows, {
  String wardValue = _dueMedsAllWards,
  String routeValue = _dueMedsAllRoutes,
  String searchQuery = '',
}) {
  final q = searchQuery.trim().toLowerCase();
  final ward = wardValue.trim();
  final route = routeValue.trim().toLowerCase();

  return rows.where((r) {
    if (ward.isNotEmpty && _filterText(r['ward_id']) != ward) return false;
    if (route.isNotEmpty &&
        route != _dueMedsAllRoutes &&
        _filterText(r['route']).toLowerCase() != route) {
      return false;
    }
    if (q.isEmpty) return true;
    final patient = _filterText(r['patient_name']).toLowerCase();
    final med =
        (_filterText(r['medication_name']).isNotEmpty
                ? _filterText(r['medication_name'])
                : _filterText(r['medication']).isNotEmpty
                ? _filterText(r['medication'])
                : _filterText(r['drug_name']))
            .toLowerCase();
    return patient.contains(q) || med.contains(q);
  }).toList();
}

String _filterText(Object? value) => (value ?? '').toString().trim();

DateTime? _replacementOrderInstant(Object? value) {
  if (value is DateTime) return value.toUtc();
  return DateTime.tryParse(_filterText(value))?.toUtc();
}

@visibleForTesting
List<Map<String, dynamic>> eligibleMarReplacementOrders({
  required List<Map<String, dynamic>> orders,
  required String patientUid,
  required int originalClinicalOrderId,
  required DateTime raisedAt,
}) {
  final expectedPatient = patientUid.trim().toLowerCase();
  if (expectedPatient.isEmpty || originalClinicalOrderId <= 0) return const [];
  final raisedInstant = raisedAt.toUtc();
  final eligible = orders
      .where((order) {
        final id = int.tryParse(_filterText(order['id']));
        final createdAt = _replacementOrderInstant(order['created_at']);
        return id != null &&
            id > 0 &&
            id != originalClinicalOrderId &&
            _filterText(order['patient_uid']).toLowerCase() ==
                expectedPatient &&
            _filterText(order['order_type']).toLowerCase() == 'medication' &&
            const {
              'ordered',
              'verified',
              'in_progress',
            }.contains(_filterText(order['status']).toLowerCase()) &&
            createdAt != null &&
            !createdAt.isBefore(raisedInstant);
      })
      .toList(growable: false);
  return [...eligible]..sort((left, right) {
    final leftAt = _replacementOrderInstant(left['created_at'])!;
    final rightAt = _replacementOrderInstant(right['created_at'])!;
    final byTime = rightAt.compareTo(leftAt);
    if (byTime != 0) return byTime;
    return int.parse(_filterText(right['id']))
        .compareTo(int.parse(_filterText(left['id'])));
  });
}

@visibleForTesting
String marReplacementOrderLabel(Map<String, dynamic> order) {
  final details = order['details'];
  final detailMap = details is Map
      ? details.cast<Object?, Object?>()
      : const {};
  final medication = _filterText(
    detailMap['medication_name'] ??
        detailMap['drug_name'] ??
        order['medication_name'],
  );
  final orderNumber = _filterText(order['order_number']);
  final id = _filterText(order['id']);
  final status = _filterText(order['status']).replaceAll('_', ' ');
  return [
    medication.isEmpty ? '#$id' : medication,
    if (orderNumber.isNotEmpty) orderNumber,
    if (status.isNotEmpty) status,
  ].join(' · ');
}

/// Nurse-facing "due meds" list. Calls `GET /clinical/mar/due` and renders
/// one row per scheduled/held dose in a ±window around now. Tapping a scheduled
/// row pushes [MarScanScreen] with the `ma_id` — this is the entry point that
/// the MAR 5-rights scanner was missing (the scanner has always required a
/// `ma_id` in its constructor, but nothing upstream fed it one).
class DueMedsScreen extends StatefulWidget {
  const DueMedsScreen({super.key, this.initialExceptionCaseId});

  final String? initialExceptionCaseId;

  @override
  State<DueMedsScreen> createState() => _DueMedsScreenState();
}

class _DueMedsScreenState extends State<DueMedsScreen> {
  List<Map<String, dynamic>> _rows = const [];
  bool _loading = true;
  String? _error;
  String _searchQuery = '';
  String _selectedWardValue = _dueMedsAllWards;
  String _selectedRouteValue = _dueMedsAllRoutes;
  List<WardListFilterOption> _wardOptions = const [
    WardListFilterOption(value: _dueMedsAllWards, label: ''),
  ];
  int? _transitioningId;
  String? _role;
  final IdempotencyAttemptRegistry _transitionAttempts =
      IdempotencyAttemptRegistry();

  bool get _canReleaseHeldDose => canReleaseHeldMarDose(_role);

  List<Map<String, dynamic>> get _filtered {
    return filterDueMedicationRows(
      _rows,
      wardValue: _selectedWardValue,
      routeValue: _selectedRouteValue,
      searchQuery: _searchQuery,
    );
  }

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  @override
  void dispose() {
    _transitionAttempts.clear();
    super.dispose();
  }

  Future<void> _initialize() async {
    try {
      final role = await AuthService.getRole();
      if (mounted) setState(() => _role = role);
    } catch (_) {
      if (mounted) setState(() => _role = null);
    }
    if (mounted) await _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final wardId = int.tryParse(_selectedWardValue);
      final loadedRows = _canReleaseHeldDose
          ? await MedicalApiService.getMedicationExceptions()
          : await MedicalApiService.getDueMedications(wardId: wardId);
      final rows = [...loadedRows];
      final initialExceptionCaseId = widget.initialExceptionCaseId;
      if (initialExceptionCaseId != null) {
        rows.sort((left, right) {
          final leftSelected =
              _filterText(left['exception_case_id']) == initialExceptionCaseId;
          final rightSelected =
              _filterText(right['exception_case_id']) == initialExceptionCaseId;
          if (leftSelected == rightSelected) return 0;
          return leftSelected ? -1 : 1;
        });
      }
      if (!mounted) return;
      setState(() {
        _rows = rows;
        final s = AppStrings.of(context);
        if (_selectedWardValue == _dueMedsAllWards ||
            _wardOptions.length <= 1) {
          _wardOptions = dueMedsWardFilterOptions(
            rows,
            allWardsLabel: s.dueMedsAllWards,
            wardFallbackLabel: s.dueMedsWardFallback,
          );
        }
        final routeValues = dueMedsRouteFilterOptions(
          rows,
          allRoutesLabel: s.dueMedsAllRoutes,
        ).map((option) => option.value).toSet();
        if (!routeValues.contains(_selectedRouteValue)) {
          _selectedRouteValue = _dueMedsAllRoutes;
        }
      });
      // Prime the offline MAR cache: a successful fetch means we are online, so
      // snapshot each patient's due doses now. Without this the bedside flow has
      // nothing to verify against when connectivity later drops (offline MAR is
      // inert without a populated cache). Best-effort — never blocks the list.
      if (!_canReleaseHeldDose) await _primeOfflineCache(rows);
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Group the due-meds rows by patient and cache each patient's doses so the
  /// MAR scan flow can run the 5-rights check offline (MarOfflineCache).
  Future<void> _primeOfflineCache(List<Map<String, dynamic>> rows) async {
    final byPatient = <String, List<Map<String, dynamic>>>{};
    for (final r in rows) {
      final uid = r['patient_uid'] as String?;
      if (uid == null || uid.isEmpty) continue;
      (byPatient[uid] ??= []).add(r);
    }
    for (final entry in byPatient.entries) {
      try {
        await MarOfflineCache.cacheDueDoses(entry.key, entry.value);
      } catch (_) {
        // best-effort priming; a cache-write failure must never block the UI.
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final wardOptions = _wardOptions
        .map(
          (option) => option.value == _dueMedsAllWards
              ? WardListFilterOption(
                  value: option.value,
                  label: s.dueMedsAllWards,
                )
              : option,
        )
        .toList();
    final routeOptions = dueMedsRouteFilterOptions(
      _rows,
      allRoutesLabel: s.dueMedsAllRoutes,
    );
    return StaffScaffold(
      title: s.dueMedsTitle,
      body: ConstrainedContent(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: TextField(
                decoration: InputDecoration(
                  hintText: s.dueMedsSearchHint,
                  prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  filled: true,
                  fillColor: AppTheme.surfaceWhite,
                ),
                onChanged: (v) => setState(() => _searchQuery = v),
              ),
            ),
            WardListFilterBar(
              keyPrefix: 'due-meds',
              wardOptions: wardOptions,
              selectedWardValue: _selectedWardValue,
              onWardChanged: (value) {
                setState(() => _selectedWardValue = value);
                _load();
              },
              filterLabel: s.dueMedsRouteFilterLabel,
              filterOptions: routeOptions,
              selectedFilterValue: _selectedRouteValue,
              onFilterChanged: (value) =>
                  setState(() => _selectedRouteValue = value),
              hasActiveFilters:
                  _selectedWardValue != _dueMedsAllWards ||
                  _selectedRouteValue != _dueMedsAllRoutes,
              onClear: () {
                setState(() {
                  _selectedWardValue = _dueMedsAllWards;
                  _selectedRouteValue = _dueMedsAllRoutes;
                });
                _load();
              },
            ),
            Expanded(
              child: RefreshIndicator(onRefresh: _load, child: _buildBody()),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _rows.isEmpty) {
      return const SkeletonList();
    }
    if (_error != null && _rows.isEmpty) {
      return _errorView(_error!);
    }
    final rows = _filtered;
    final s = AppStrings.of(context);
    if (rows.isEmpty) {
      if (_searchQuery.trim().isNotEmpty) {
        return ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            const SizedBox(height: 120),
            Center(
              child: Text(
                s.noMatchesFor(_searchQuery),
                style: const TextStyle(color: Colors.black54),
              ),
            ),
          ],
        );
      }
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const SizedBox(height: 80),
          EmptyState(
            icon: Icons.medication_outlined,
            title: s.dueMedsEmptyTitle,
            body: s.dueMedsEmptyBody,
          ),
        ],
      );
    }

    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: rows.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final row = rows[i];
        final id = _rowId(row);
        return _DueMedTile(
          row: row,
          busy: id != null && id == _transitioningId,
          onTap: canOpenMarScanner(row) ? () => _openScanner(row) : null,
          onTransition: (action) => _recordTransition(row, action),
          canReleaseHold: _canReleaseHeldDose,
          canReviewException: _canReleaseHeldDose,
        );
      },
    );
  }

  void _openScanner(Map<String, dynamic> row) {
    final maId = _rowId(row);
    if (maId == null) return;
    context.push('/mar/scan/$maId').then((_) {
      if (mounted) _load();
    });
  }

  int? _rowId(Map<String, dynamic> row) {
    final raw = row['id'];
    return raw is int ? raw : int.tryParse(raw?.toString() ?? '');
  }

  Future<void> _recordTransition(
    Map<String, dynamic> row,
    MarDueTransition action,
  ) async {
    if (action == MarDueTransition.reviewException) {
      await _recordExceptionDisposition(row);
      return;
    }
    final maId = _rowId(row);
    if (maId == null || _transitioningId != null) return;
    final s = AppStrings.of(context);
    final reason = await _promptForTransitionReason(action);
    if (reason == null || !mounted) return;
    final attemptScope = 'mar-${action.name}:$maId';
    final requestBody = <String, dynamic>{'reason': reason.trim()};
    final idempotencyKey = _transitionAttempts.keyFor(
      attemptScope,
      requestBody,
    );

    setState(() => _transitioningId = maId);
    try {
      switch (action) {
        case MarDueTransition.miss:
          await MedicalApiService.markMedicationMissed(
            maId: maId,
            reason: reason,
            idempotencyKey: idempotencyKey,
          );
        case MarDueTransition.hold:
          await MedicalApiService.holdMedication(
            maId: maId,
            reason: reason,
            idempotencyKey: idempotencyKey,
          );
        case MarDueTransition.releaseHold:
          if (!_canReleaseHeldDose) return;
          await MedicalApiService.releaseHeldMedication(
            maId: maId,
            reason: reason,
            idempotencyKey: idempotencyKey,
          );
        case MarDueTransition.reviewException:
          return;
      }
      _transitionAttempts.complete(attemptScope);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            s.lookup(switch (action) {
              MarDueTransition.miss => 'due_meds.actions.miss_success',
              MarDueTransition.hold => 'due_meds.actions.hold_success',
              MarDueTransition.releaseHold =>
                'due_meds.actions.release_success',
              MarDueTransition.reviewException =>
                'clinical_inbox.review_action',
            }),
          ),
        ),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(localizedApiErrorFromRaw(AppStrings.of(context), e)),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _transitioningId = null);
    }
  }

  Future<String?> _promptForTransitionReason(MarDueTransition action) async {
    var reason = '';
    return showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) {
        final s = AppStrings.of(dialogContext);
        return StatefulBuilder(
          builder: (context, setDialogState) {
            final valid = reason.trim().length >= 5;
            return AlertDialog(
              title: Text(
                s.lookup(switch (action) {
                  MarDueTransition.miss => 'due_meds.actions.miss_title',
                  MarDueTransition.hold => 'due_meds.actions.hold_title',
                  MarDueTransition.releaseHold =>
                    'due_meds.actions.release_title',
                  MarDueTransition.reviewException =>
                    'clinical_inbox.review_action',
                }),
              ),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.lookup(switch (action) {
                      MarDueTransition.miss => 'due_meds.actions.miss_body',
                      MarDueTransition.hold => 'due_meds.actions.hold_body',
                      MarDueTransition.releaseHold =>
                        'due_meds.actions.release_body',
                      MarDueTransition.reviewException =>
                        'due_meds.actions.miss_body',
                    }),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    autofocus: true,
                    maxLength: 500,
                    minLines: 2,
                    maxLines: 4,
                    decoration: InputDecoration(
                      labelText: s.lookup('due_meds.actions.reason_label'),
                      hintText: s.lookup('due_meds.actions.reason_hint'),
                      errorText: reason.isNotEmpty && !valid
                          ? s.lookup('due_meds.actions.reason_required')
                          : null,
                    ),
                    onChanged: (value) => setDialogState(() => reason = value),
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(),
                  child: Text(s.lookup('due_meds.actions.cancel')),
                ),
                FilledButton(
                  onPressed: valid
                      ? () => Navigator.of(dialogContext).pop(reason.trim())
                      : null,
                  child: Text(
                    s.lookup(switch (action) {
                      MarDueTransition.miss => 'due_meds.actions.confirm_miss',
                      MarDueTransition.hold => 'due_meds.actions.confirm_hold',
                      MarDueTransition.releaseHold =>
                        'due_meds.actions.confirm_release',
                      MarDueTransition.reviewException => 'action.confirm',
                    }),
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Future<void> _recordExceptionDisposition(Map<String, dynamic> row) async {
    final caseId = _filterText(row['exception_case_id']);
    final maId = _rowId(row);
    if (!_isCanonicalPositiveBigInt(caseId) ||
        maId == null ||
        _transitioningId != null) {
      return;
    }
    final disposition = await _promptForExceptionDisposition(row);
    if (disposition == null || !mounted) return;
    final requestBody = <String, dynamic>{
      'disposition': disposition.code,
      'reason': disposition.reason,
      'replacement_clinical_order_id': disposition.replacementClinicalOrderId,
    };
    final attemptScope = 'mar-exception-disposition:$caseId';
    final idempotencyKey = _transitionAttempts.keyFor(
      attemptScope,
      requestBody,
    );
    setState(() => _transitioningId = maId);
    try {
      await MedicalApiService.recordMedicationExceptionDisposition(
        caseId: caseId,
        disposition: disposition.code,
        reason: disposition.reason,
        replacementClinicalOrderId: disposition.replacementClinicalOrderId,
        idempotencyKey: idempotencyKey,
      );
      _transitionAttempts.complete(attemptScope);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppStrings.of(context).clinicalInboxReviewAction),
        ),
      );
      await _load();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            localizedApiErrorFromRaw(AppStrings.of(context), error),
          ),
          backgroundColor: AppTheme.errorRed,
        ),
      );
    } finally {
      if (mounted) setState(() => _transitioningId = null);
    }
  }

  Future<List<Map<String, dynamic>>> _loadReplacementOrders(
    Map<String, dynamic> row,
  ) async {
    final patientUid = _filterText(row['patient_uid']);
    final originalOrderId = int.tryParse(_filterText(row['clinical_order_id']));
    final raisedAt = _replacementOrderInstant(row['raised_at']);
    if (patientUid.isEmpty || originalOrderId == null || raisedAt == null) {
      return const [];
    }
    final orders = await MedicalApiService.getPatientMedicationOrders(
      patientUid,
    );
    return eligibleMarReplacementOrders(
      orders: orders,
      patientUid: patientUid,
      originalClinicalOrderId: originalOrderId,
      raisedAt: raisedAt,
    );
  }

  Future<MarExceptionDisposition?> _promptForExceptionDisposition(
    Map<String, dynamic> row,
  ) async {
    final exceptionKind = _filterText(row['exception_kind']).toLowerCase();
    final orderIsActive = const {
      'ordered',
      'verified',
      'in_progress',
    }.contains(_filterText(row['clinical_order_status']).toLowerCase());
    final choices = <String>[
      if (exceptionKind == 'missed') 'reviewed_no_replacement',
      if (exceptionKind == 'missed') 'replacement_ordered',
      if (!orderIsActive) 'order_stopped',
    ];
    if (choices.isEmpty) return null;

    while (mounted) {
      var candidates = <Map<String, dynamic>>[];
      var candidateLoadFailed = false;
      try {
        candidates = await _loadReplacementOrders(row);
      } catch (_) {
        candidateLoadFailed = true;
      }
      if (!mounted) return null;

      var selected = choices.first;
      var reason = '';
      var search = '';
      int? selectedReplacementOrderId;
      var loadingCandidates = false;
      final result = await showDialog<_MarExceptionPromptResult>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) {
          final s = AppStrings.of(dialogContext);
          return StatefulBuilder(
            builder: (context, setDialogState) {
              final visibleCandidates = candidates
                  .where((candidate) {
                    final query = search.trim().toLowerCase();
                    return query.isEmpty ||
                        marReplacementOrderLabel(candidate)
                            .toLowerCase()
                            .contains(query);
                  })
                  .toList(growable: false);
              final selectedCandidateIsVisible = visibleCandidates.any(
                (candidate) =>
                    int.tryParse(_filterText(candidate['id'])) ==
                    selectedReplacementOrderId,
              );
              final valid =
                  reason.trim().length >= 5 &&
                  (selected != 'replacement_ordered' ||
                      selectedCandidateIsVisible);
              String label(String code) => switch (code) {
                'reviewed_no_replacement' => s.clinicalInboxActionNoAction,
                'replacement_ordered' => s.ordersNewOrder,
                'order_stopped' => s.drugChartStopButton,
                _ => code,
              };
              Future<void> refreshCandidates() async {
                setDialogState(() {
                  loadingCandidates = true;
                  candidateLoadFailed = false;
                });
                try {
                  final refreshed = await _loadReplacementOrders(row);
                  if (!dialogContext.mounted) return;
                  setDialogState(() {
                    candidates = refreshed;
                    if (!candidates.any(
                      (candidate) =>
                          int.tryParse(_filterText(candidate['id'])) ==
                          selectedReplacementOrderId,
                    )) {
                      selectedReplacementOrderId = null;
                    }
                  });
                } catch (_) {
                  if (!dialogContext.mounted) return;
                  setDialogState(() => candidateLoadFailed = true);
                } finally {
                  if (dialogContext.mounted) {
                    setDialogState(() => loadingCandidates = false);
                  }
                }
              }

              return AlertDialog(
                title: Text(s.clinicalInboxActionDisposition),
                content: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      DropdownButtonFormField<String>(
                        initialValue: selected,
                        decoration: InputDecoration(
                          labelText: s.clinicalInboxActionDisposition,
                        ),
                        items: choices
                            .map(
                              (code) => DropdownMenuItem(
                                value: code,
                                child: Text(label(code)),
                              ),
                            )
                            .toList(growable: false),
                        onChanged: (value) => setDialogState(() {
                          selected = value ?? choices.first;
                          if (selected != 'replacement_ordered') {
                            selectedReplacementOrderId = null;
                          }
                        }),
                      ),
                      if (selected == 'replacement_ordered') ...[
                        const SizedBox(height: 12),
                        TextField(
                          decoration: InputDecoration(
                            labelText: s.actionSearch,
                            hintText: s.composerSearchHint,
                            suffixIcon: IconButton(
                              tooltip: s.actionRefresh,
                              onPressed: loadingCandidates
                                  ? null
                                  : refreshCandidates,
                              icon: loadingCandidates
                                  ? const SizedBox.square(
                                      dimension: 18,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Icon(Icons.refresh),
                            ),
                          ),
                          onChanged: (value) => setDialogState(() {
                            search = value;
                            if (!candidates.any(
                              (candidate) =>
                                  int.tryParse(_filterText(candidate['id'])) ==
                                  selectedReplacementOrderId,
                            )) {
                              selectedReplacementOrderId = null;
                            }
                          }),
                        ),
                        const SizedBox(height: 12),
                        if (candidateLoadFailed || visibleCandidates.isEmpty)
                          Align(
                            alignment: Alignment.centerLeft,
                            child: Text(s.ordersNoFound),
                          )
                        else
                          DropdownButtonFormField<int>(
                            initialValue: selectedCandidateIsVisible
                                ? selectedReplacementOrderId
                                : null,
                            isExpanded: true,
                            decoration: InputDecoration(
                              labelText: s.ordersTitle,
                            ),
                            items: visibleCandidates
                                .map(
                                  (candidate) => DropdownMenuItem<int>(
                                    value: int.parse(
                                      _filterText(candidate['id']),
                                    ),
                                    child: Text(
                                      marReplacementOrderLabel(candidate),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                )
                                .toList(growable: false),
                            onChanged: (value) => setDialogState(
                              () => selectedReplacementOrderId = value,
                            ),
                          ),
                      ],
                      const SizedBox(height: 12),
                      TextField(
                        maxLength: 500,
                        minLines: 2,
                        maxLines: 4,
                        decoration: InputDecoration(
                          labelText: s.lookup('due_meds.actions.reason_label'),
                          hintText: s.lookup('due_meds.actions.reason_hint'),
                        ),
                        onChanged: (value) =>
                            setDialogState(() => reason = value),
                      ),
                    ],
                  ),
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(dialogContext).pop(),
                    child: Text(s.actionCancel),
                  ),
                  if (selected == 'replacement_ordered' &&
                      _filterText(row['patient_uid']).isNotEmpty)
                    TextButton(
                      onPressed: () => Navigator.of(dialogContext)
                          .pop(const _MarExceptionPromptResult.createOrder()),
                      child: Text(s.ordersNewOrder),
                    ),
                  FilledButton(
                    onPressed: valid
                        ? () => Navigator.of(dialogContext).pop(
                            _MarExceptionPromptResult.disposition(
                              MarExceptionDisposition(
                                code: selected,
                                reason: reason.trim(),
                                replacementClinicalOrderId:
                                    selected == 'replacement_ordered'
                                    ? selectedReplacementOrderId
                                    : null,
                              ),
                            ),
                          )
                        : null,
                    child: Text(s.actionConfirm),
                  ),
                ],
              );
            },
          );
        },
      );
      if (result == null) return null;
      if (!result.createOrder) return result.disposition;

      final patientUid = _filterText(row['patient_uid']);
      if (patientUid.isEmpty || !mounted) return null;
      final route = Uri(
        path: '/emr/orders/$patientUid/compose',
        queryParameters: {
          if (_filterText(row['patient_name']).isNotEmpty)
            'name': _filterText(row['patient_name']),
          if (_filterText(row['encounter_id']).isNotEmpty)
            'encounter': _filterText(row['encounter_id']),
        },
      ).toString();
      await context.push<void>(route);
    }
    return null;
  }

  Widget _errorView(String msg) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 60),
        ErrorState(message: stripExceptionPrefix(msg), onRetry: _load),
      ],
    );
  }
}

class _DueMedTile extends StatelessWidget {
  const _DueMedTile({
    required this.row,
    required this.onTap,
    required this.onTransition,
    required this.busy,
    required this.canReleaseHold,
    required this.canReviewException,
  });

  final Map<String, dynamic> row;
  final VoidCallback? onTap;
  final ValueChanged<MarDueTransition> onTransition;
  final bool busy;
  final bool canReleaseHold;
  final bool canReviewException;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final scheduled = _parseTime(row['scheduled_time']);
    final minutesDelta = scheduled == null
        ? null
        : DateTime.now().difference(scheduled).inMinutes;

    final overdue = minutesDelta != null && minutesDelta > 0;
    final color = overdue ? AppTheme.errorRed : AppTheme.successGreen;
    final timeLabel = scheduled == null
        ? s.dueMedsUnscheduled
        : _relativeLabel(s, minutesDelta!);

    final patientName = (row['patient_name'] as String?)?.trim();
    final bedNumber = (row['bed_number'] as String?)?.trim();
    final wardName = (row['ward_name'] as String?)?.trim();
    final med =
        (row['medication_name'] as String?)?.trim() ??
        s.dueMedsUnnamedMedication;
    final dose = (row['dose'] as String?) ?? (row['dosage'] as String?) ?? '';
    final route = (row['route'] as String?) ?? '';
    final status = (row['status'] as String?) ?? '';

    final subtitle = <String>[
      if (dose.isNotEmpty) dose,
      if (route.isNotEmpty) route,
      if (status == 'held') s.dueMedsHeldBadge,
    ].join(' · ');

    final whoLine = <String>[
      patientName == null || patientName.isEmpty
          ? s.dueMedsUnknownPatient
          : patientName,
      if (bedNumber != null && bedNumber.isNotEmpty) s.bedNumber(bedNumber),
      if (wardName != null && wardName.isNotEmpty) wardName,
    ].join(' · ');

    return ListTile(
      onTap: onTap,
      leading: CircleAvatar(
        backgroundColor: color.withValues(alpha: 0.15),
        child: Icon(overdue ? Icons.schedule : Icons.medication, color: color),
      ),
      title: Text(
        med,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (subtitle.isNotEmpty)
            Text(subtitle, style: const TextStyle(fontSize: 13)),
          if (status == 'held')
            Text(
              s.lookup('due_meds.held_review_state'),
              key: const Key('due-med-held-review-state'),
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context).colorScheme.error,
                fontWeight: FontWeight.w600,
              ),
            ),
          Text(
            whoLine,
            style: const TextStyle(fontSize: 12, color: Colors.black54),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            timeLabel,
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w600,
              fontSize: 13,
            ),
          ),
          if (busy)
            const Padding(
              padding: EdgeInsets.only(left: 12),
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else if (availableMarDueTransitions(
            row,
            canReleaseHold: canReleaseHold,
            canReviewException: canReviewException,
          ).isNotEmpty)
            PopupMenuButton<MarDueTransition>(
              tooltip: s.lookup('due_meds.actions.label'),
              onSelected: onTransition,
              itemBuilder: (context) =>
                  availableMarDueTransitions(
                        row,
                        canReleaseHold: canReleaseHold,
                        canReviewException: canReviewException,
                      )
                      .map(
                        (action) => PopupMenuItem(
                          value: action,
                          child: Text(
                            s.lookup(switch (action) {
                              MarDueTransition.miss => 'due_meds.actions.miss',
                              MarDueTransition.hold => 'due_meds.actions.hold',
                              MarDueTransition.releaseHold =>
                                'due_meds.actions.release',
                              MarDueTransition.reviewException =>
                                'clinical_inbox.review_action',
                            }),
                          ),
                        ),
                      )
                      .toList(growable: false),
            ),
        ],
      ),
    );
  }

  static DateTime? _parseTime(Object? v) {
    if (v == null) return null;
    try {
      return DateTime.parse(v.toString()).toLocal();
    } catch (_) {
      return null;
    }
  }

  static String _relativeLabel(AppStrings s, int minutesDelta) {
    if (minutesDelta == 0) return s.timeJustNow;
    final abs = minutesDelta.abs();
    final value = abs < 60
        ? '${abs}m'
        : '${(abs / 60).toStringAsFixed(abs % 60 == 0 ? 0 : 1)}h';
    return minutesDelta > 0 ? s.dueMedsDueLate(value) : s.dueMedsDueIn(value);
  }
}
