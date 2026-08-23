import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:vhhealth_core/services/idempotency_key.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/constrained_content.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/patient_search_sheet.dart';
import '../../../l10n/app_strings.dart';
import '../models/blood_request.dart';
import '../services/blood_bank_gateway.dart';

int? _intValue(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

String? _nonEmptyString(dynamic value) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? null : text;
}

typedef BloodBankPatientPicker = Future<BloodRequestPatient?> Function(
  BuildContext context,
);

class BloodBankScreen extends StatefulWidget {
  final BloodBankGateway gateway;
  final BloodBankPatientPicker? patientPicker;

  const BloodBankScreen({
    super.key,
    this.gateway = const ApiBloodBankGateway(),
    this.patientPicker,
  });

  @override
  State<BloodBankScreen> createState() => _BloodBankScreenState();
}

class _BloodBankScreenState extends State<BloodBankScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  // Inventory
  List<Map<String, dynamic>> _inventory = [];
  bool _loadingInventory = true;
  String? _inventoryError;

  // Issued units awaiting two-person bedside verification.
  List<Map<String, dynamic>> _issuedUnits = [];
  bool _loadingIssuedUnits = true;
  String? _issuedUnitsError;

  // Request form
  final _requestFormKey = GlobalKey<FormState>();
  BloodRequestPatient? _requestPatient;
  String? _requestBloodType;
  BloodComponent? _requestComponent;
  BloodUrgency _requestUrgency = BloodUrgency.routine;
  final _unitsController = TextEditingController();
  final _indicationController = TextEditingController();
  bool _submittingRequest = false;
  String? _requestIntentFingerprint;
  String? _requestIdempotencyKey;

  static const List<String> _bloodTypes = [
    'A+',
    'A-',
    'B+',
    'B-',
    'O+',
    'O-',
    'AB+',
    'AB-',
  ];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _fetchInventory();
    _fetchIssuedUnits();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _unitsController.dispose();
    _indicationController.dispose();
    super.dispose();
  }

  Future<void> _fetchInventory() async {
    setState(() {
      _loadingInventory = true;
      _inventoryError = null;
    });
    try {
      final response = await widget.gateway.getInventory();
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['inventory'] ?? data['items'] ?? [] : []);
        _inventory = List<Map<String, dynamic>>.from(
          (list as List).map(
            (i) => i is Map<String, dynamic> ? i : <String, dynamic>{},
          ),
        );
      } else {
        _inventoryError = response.failureMessage('Failed to load inventory');
      }
    } catch (e) {
      _inventoryError = AppStrings.of(context).commonServerUnreachable;
    } finally {
      if (mounted) setState(() => _loadingInventory = false);
    }
  }

  Future<void> _fetchIssuedUnits() async {
    setState(() {
      _loadingIssuedUnits = true;
      _issuedUnitsError = null;
    });
    try {
      final response = await widget.gateway.getIssuedUnits();
      if (response.isSuccess) {
        final data = response.data;
        final list = data is Map ? data['units'] ?? data['items'] ?? [] : data;
        _issuedUnits = List<Map<String, dynamic>>.from(
          (list is List ? list : const []).map(
            (i) => i is Map<String, dynamic> ? i : <String, dynamic>{},
          ),
        );
      } else {
        _issuedUnitsError = response.failureMessage(
          'Failed to load issued blood units',
        );
      }
    } catch (_) {
      _issuedUnitsError = AppStrings.of(context).commonServerUnreachable;
    } finally {
      if (mounted) setState(() => _loadingIssuedUnits = false);
    }
  }

  Future<void> _refreshAll() async {
    await Future.wait([_fetchInventory(), _fetchIssuedUnits()]);
  }

  Future<void> _submitRequest() async {
    if (!_requestFormKey.currentState!.validate()) return;
    final s = AppStrings.of(context);
    setState(() => _submittingRequest = true);
    try {
      final payload = BloodRequestPayload(
        patientUid: _requestPatient!.uid,
        bloodGroup: _requestBloodType!,
        units: int.parse(_unitsController.text.trim()),
        component: _requestComponent!,
        clinicalIndication: _indicationController.text.trim(),
        urgency: _requestUrgency,
      );
      final response = await widget.gateway.createRequest(
        payload,
        idempotencyKey: _idempotencyKeyFor(payload),
      );
      if (mounted) {
        if (response.isSuccess) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(s.bloodBankRequestSuccess),
              backgroundColor: AppTheme.successGreen,
            ),
          );
          _requestFormKey.currentState!.reset();
          _unitsController.clear();
          _indicationController.clear();
          setState(() {
            _requestPatient = null;
            _requestBloodType = null;
            _requestComponent = null;
            _requestUrgency = BloodUrgency.routine;
            _requestIntentFingerprint = null;
            _requestIdempotencyKey = null;
          });
          unawaited(_fetchInventory());
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(response.failureMessage(s.errorSomethingWentWrong)),
              backgroundColor: AppTheme.errorRed,
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(s.errorSomethingWentWrong),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submittingRequest = false);
    }
  }

  String _idempotencyKeyFor(BloodRequestPayload payload) {
    final fingerprint = jsonEncode(payload.toJson());
    if (_requestIntentFingerprint != fingerprint ||
        _requestIdempotencyKey == null) {
      _requestIntentFingerprint = fingerprint;
      _requestIdempotencyKey = IdempotencyKey.generate();
    }
    return _requestIdempotencyKey!;
  }

  Future<BloodRequestPatient?> _pickPatient() async {
    final injectedPicker = widget.patientPicker;
    if (injectedPicker != null) return injectedPicker(context);
    final result = await PatientSearchSheet.pick(context);
    if (result == null) return null;
    return BloodRequestPatient.fromSearchResult(result);
  }

  String _componentLabel(AppStrings s, BloodComponent component) =>
      switch (component) {
        BloodComponent.wholeBlood => s.bloodBankComponentWholeBlood,
        BloodComponent.packedRedBloodCells => s.bloodBankComponentPrbc,
        BloodComponent.freshFrozenPlasma => s.bloodBankComponentFfp,
        BloodComponent.platelets => s.bloodBankComponentPlatelets,
        BloodComponent.cryoprecipitate => s.bloodBankComponentCryoprecipitate,
      };

  String _urgencyLabel(AppStrings s, BloodUrgency urgency) => switch (urgency) {
    BloodUrgency.routine => s.bloodBankUrgencyRoutine,
    BloodUrgency.urgent => s.bloodBankUrgencyUrgent,
    BloodUrgency.emergency => s.bloodBankUrgencyEmergency,
  };

  Color _stockColor(int units) {
    if (units < 5) return AppTheme.errorRed;
    if (units < 10) return const Color(0xFFF9A825);
    return AppTheme.successGreen;
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.bloodBankTitle),
        backgroundColor: AppTheme.errorRed,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: s.bloodBankRefreshTooltip,
            onPressed: _refreshAll,
          ),
          const LogoutAction(),
        ],
        bottom: TabBar(
          controller: _tabController,
          isScrollable: true,
          indicatorColor: Colors.white,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white60,
          tabs: [
            Tab(text: s.bloodBankTabInventory),
            Tab(text: s.bloodBankTabRequests),
            Tab(
              text: AppStrings.of(context)
                  .lookup('s4.lib.blood_bank.transfusions'),
            ),
            Tab(text: s.bloodBankTabDonations),
          ],
        ),
      ),
      body: ConstrainedContent(
        child: TabBarView(
          controller: _tabController,
          children: [
            _buildInventoryTab(),
            _buildRequestsTab(),
            _buildTransfusionsTab(),
            _buildDonationsTab(),
          ],
        ),
      ),
    );
  }

  Widget _buildInventoryTab() {
    if (_loadingInventory) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_inventoryError != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
            const SizedBox(height: 16),
            Text(
              _inventoryError!,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _fetchInventory,
              icon: const Icon(Icons.refresh),
              label: Text(AppStrings.of(context).actionRetry),
            ),
          ],
        ),
      );
    }

    final s = AppStrings.of(context);
    // If API returned data, use it; otherwise show placeholder cards for all types
    final displayItems = _inventory.isNotEmpty
        ? _inventory
        : _bloodTypes
              .map((t) => <String, dynamic>{'bloodType': t, 'units': 0})
              .toList();

    return RefreshIndicator(
      onRefresh: _fetchInventory,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Stock level legend
          Row(
            children: [
              _legendDot(AppTheme.successGreen, s.bloodBankLegendAdequate),
              const SizedBox(width: 12),
              _legendDot(const Color(0xFFF9A825), s.bloodBankLegendLow),
              const SizedBox(width: 12),
              _legendDot(AppTheme.errorRed, s.bloodBankLegendCritical),
            ],
          ),
          const SizedBox(height: 16),

          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1.4,
            ),
            itemCount: displayItems.length,
            itemBuilder: (context, index) {
              final item = displayItems[index];
              final type = (item['bloodType'] ?? item['type'] ?? '?')
                  .toString();
              final units = item['units'] ?? item['quantity'] ?? 0;
              final intUnits = units is int
                  ? units
                  : int.tryParse(units.toString()) ?? 0;
              final color = _stockColor(intUnits);

              return Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: color.withValues(alpha: 0.4)),
                  boxShadow: [
                    BoxShadow(
                      color: color.withValues(alpha: 0.1),
                      blurRadius: 8,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.bloodtype, color: color, size: 22),
                        const SizedBox(width: 8),
                        Text(
                          type,
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                            color: color,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '$intUnits ${s.bloodBankUnitsSuffix}',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: color,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      intUnits < 5
                          ? s.bloodBankStockCriticalLow
                          : intUnits < 10
                          ? s.bloodBankStockLow
                          : s.bloodBankStockAdequate,
                      style: TextStyle(fontSize: 11, color: color),
                    ),
                  ],
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _buildRequestsTab() {
    final s = AppStrings.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _requestFormKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.bloodBankRequestHeader,
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 16),

            FormField<BloodRequestPatient>(
              key: ValueKey(
                'blood_request_patient_${_requestPatient?.uid ?? 'none'}',
              ),
              initialValue: _requestPatient,
              validator: (patient) =>
                  patient == null ? s.bloodBankSelectPatientRequired : null,
              builder: (field) => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  OutlinedButton(
                    key: const Key('blood_request_patient_picker'),
                    onPressed: _submittingRequest
                        ? null
                        : () async {
                            final selected = await _pickPatient();
                            if (selected == null || !mounted) return;
                            field.didChange(selected);
                            setState(() => _requestPatient = selected);
                          },
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(60),
                      alignment: Alignment.centerLeft,
                      side: BorderSide(
                        color: field.hasError
                            ? AppTheme.errorRed
                            : Colors.grey.shade400,
                      ),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.person_search_outlined),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _requestPatient == null
                              ? Text(s.bloodBankSelectPatientLabel)
                              : Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Text(
                                      _requestPatient!.name,
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                    if (_requestPatient!
                                        .hospitalNumber
                                        .isNotEmpty)
                                      Text(
                                        _requestPatient!.hospitalNumber,
                                        style: TextStyle(
                                          color: AppTheme.textSecondary,
                                        ),
                                      ),
                                  ],
                                ),
                        ),
                        const Icon(Icons.chevron_right),
                      ],
                    ),
                  ),
                  if (field.errorText != null)
                    Padding(
                      padding: const EdgeInsets.only(left: 12, top: 6),
                      child: Text(
                        field.errorText!,
                        style: const TextStyle(
                          color: AppTheme.errorRed,
                          fontSize: 12,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 14),

            DropdownButtonFormField<String>(
              key: const Key('blood_request_group'),
              initialValue: _requestBloodType,
              decoration: InputDecoration(
                labelText: s.bloodBankBloodTypeLabel,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.bloodtype_outlined),
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: AppTheme.surfaceWhite,
              ),
              items: _bloodTypes
                  .map((t) => DropdownMenuItem(value: t, child: Text(t)))
                  .toList(),
              onChanged: (v) => setState(() => _requestBloodType = v),
              validator: (v) => v == null ? s.bloodBankBloodTypeRequired : null,
            ),
            const SizedBox(height: 14),

            DropdownButtonFormField<BloodComponent>(
              key: const Key('blood_request_component'),
              initialValue: _requestComponent,
              decoration: InputDecoration(
                labelText: s.bloodBankComponentLabel,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.water_drop_outlined),
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: AppTheme.surfaceWhite,
              ),
              items: BloodComponent.values
                  .map(
                    (component) => DropdownMenuItem(
                      value: component,
                      child: Text(_componentLabel(s, component)),
                    ),
                  )
                  .toList(growable: false),
              onChanged: (component) =>
                  setState(() => _requestComponent = component),
              validator: (component) =>
                  component == null ? s.bloodBankComponentRequired : null,
            ),
            const SizedBox(height: 14),

            TextFormField(
              key: const Key('blood_request_units'),
              controller: _unitsController,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: s.bloodBankUnitsLabel,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.numbers)),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: AppTheme.surfaceWhite,
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) {
                  return s.bloodBankUnitsRequired;
                }
                final n = int.tryParse(v.trim());
                if (n == null || n < 1 || n > 10) {
                  return s.bloodBankUnitsRange;
                }
                return null;
              },
            ),
            const SizedBox(height: 14),

            TextFormField(
              key: const Key('blood_request_indication'),
              controller: _indicationController,
              maxLines: 3,
              maxLength: 500,
              decoration: InputDecoration(
                labelText: s.bloodBankClinicalIndicationLabel,
                prefixIcon: const Padding(
                  padding: EdgeInsets.only(bottom: 40),
                  child: Icon(Icons.notes),
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: AppTheme.surfaceWhite,
              ),
              validator: (value) => value == null || value.trim().isEmpty
                  ? s.bloodBankClinicalIndicationRequired
                  : null,
            ),
            const SizedBox(height: 14),

            DropdownButtonFormField<BloodUrgency>(
              key: const Key('blood_request_urgency'),
              initialValue: _requestUrgency,
              decoration: InputDecoration(
                labelText: s.bloodBankUrgencyLabel,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.priority_high),
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                filled: true,
                fillColor: AppTheme.surfaceWhite,
              ),
              items: BloodUrgency.values
                  .map(
                    (urgency) => DropdownMenuItem(
                      value: urgency,
                      child: Text(_urgencyLabel(s, urgency)),
                    ),
                  )
                  .toList(growable: false),
              onChanged: (urgency) {
                if (urgency != null) {
                  setState(() => _requestUrgency = urgency);
                }
              },
            ),
            const SizedBox(height: 20),

            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton.icon(
                key: const Key('blood_request_submit'),
                onPressed: _submittingRequest ? null : _submitRequest,
                icon: _submittingRequest
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Icon(Icons.send),
                label: Text(
                  _submittingRequest
                      ? s.bloodBankSubmittingButton
                      : s.bloodBankSubmitRequest,
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.errorRed,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDonationsTab() {
    final s = AppStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(
              Icons.volunteer_activism,
              size: 64,
              color: AppTheme.errorRed,
            ),
            const SizedBox(height: 16),
            Text(
              s.bloodBankDonationsTitle,
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
                color: AppTheme.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              s.bloodBankDonationsBody,
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTransfusionsTab() {
    if (_loadingIssuedUnits) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_issuedUnitsError != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.error_outline,
                size: 48,
                color: AppTheme.errorRed,
              ),
              const SizedBox(height: 12),
              Text(_issuedUnitsError!, textAlign: TextAlign.center),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: _fetchIssuedUnits,
                icon: const Icon(Icons.refresh),
                label: Text(AppStrings.of(context).actionRetry),
              ),
            ],
          ),
        ),
      );
    }
    if (_issuedUnits.isEmpty) {
      return RefreshIndicator(
        onRefresh: _fetchIssuedUnits,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 80),
            Icon(
              Icons.bloodtype_outlined,
              size: 56,
              color: Colors.grey.shade400,
            ),
            const SizedBox(height: 12),
            AppText(
              's4.lib.blood_bank.no_issued_units_awaiting_bedside_verification',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchIssuedUnits,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _issuedUnits.length,
        itemBuilder: (context, index) =>
            _buildIssuedUnitCard(_issuedUnits[index]),
      ),
    );
  }

  Widget _buildIssuedUnitCard(Map<String, dynamic> unit) {
    final requestId = _intValue(unit['request_id']);
    final unitNumber = _nonEmptyString(unit['unit_number']);
    final bloodGroup = _nonEmptyString(unit['blood_group']) ?? '-';
    final component = _nonEmptyString(unit['component']) ?? 'blood unit';

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.bloodtype, color: AppTheme.errorRed),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    unitNumber ?? 'Issued unit',
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                Text(
                  bloodGroup,
                  style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    color: AppTheme.errorRed,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              '${component.toUpperCase()} - request #${requestId ?? '-'}',
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: requestId == null
                      ? null
                      : () => _openTransfusionScan(
                          requestId: requestId,
                          unitNumber: unitNumber,
                          verifierRole: 'first',
                        ),
                  icon: const Icon(Icons.filter_1),
                  label: const AppText('s4.lib.blood_bank.first_verifier'),
                ),
                ElevatedButton.icon(
                  onPressed: requestId == null
                      ? null
                      : () => _openTransfusionScan(
                          requestId: requestId,
                          unitNumber: unitNumber,
                          verifierRole: 'second',
                        ),
                  icon: const Icon(Icons.filter_2),
                  label: const AppText('s4.lib.blood_bank.second_verifier'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.errorRed,
                    foregroundColor: Colors.white,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _openTransfusionScan({
    required int requestId,
    required String verifierRole,
    String? unitNumber,
  }) async {
    final params = <String, String>{'role': verifierRole};
    if (unitNumber != null) params['unit_number'] = unitNumber;
    final uri = Uri(
      path: '/blood-bank/scan/$requestId',
      queryParameters: params,
    );
    final verified = await context.push<bool>(uri.toString());
    if (verified != true || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: AppText('s4.lib.blood_bank.bedside_verification_recorded'),
        backgroundColor: AppTheme.successGreen,
      ),
    );
    unawaited(_fetchIssuedUnits());
  }

  Widget _legendDot(Color color, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(fontSize: 11, color: AppTheme.textSecondary),
        ),
      ],
    );
  }
}
