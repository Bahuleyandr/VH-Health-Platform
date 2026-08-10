import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../core/config/api_config.dart';
import '../../../core/services/connectivity_sync_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/api_error_messages.dart';
import '../../../core/utils/patient_identity.dart';
import '../../../core/widgets/patient_context_chip.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../core/widgets/states/empty_state.dart';
import '../../../core/widgets/states/error_state.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../core/widgets/vital_text_field.dart';
import '../../../core/widgets/voice_dictate_button.dart';
import '../../../l10n/app_strings.dart';

/// Positive patient identification for quick vitals (STF-4).
///
/// The MAR 5-rights flow established the wristband-scan pattern: the QR on
/// the patient wristband carries the patient UID. Quick vitals now follows
/// it — scan (or verify a typed identifier) → the backend resolves the
/// patient → the nurse confirms name/identifiers before anything is charted.
/// Free-typed patient IDs are never charted against unverified.
final RegExp quickVitalsUuidRe = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);

/// Pick the positively-identified row out of patient-search results:
/// an exact uid match for wristband scans, or an exact numeric-id match for
/// manually verified IDs. Anything else (fuzzy hits) returns null.
Map<String, dynamic>? resolveQuickVitalsPatient(
  List<Map<String, dynamic>> rows, {
  String? scannedUid,
  int? manualId,
}) {
  for (final row in rows) {
    if (scannedUid != null &&
        patientUidFrom(row).toLowerCase() == scannedUid.toLowerCase()) {
      return row;
    }
    if (manualId != null && int.tryParse(patientIdFrom(row)) == manualId) {
      return row;
    }
  }
  return null;
}

/// Vitals Entry screen — for Nursing Staff to record patient vitals.
///
/// When opened from the bed-board's "Record Vitals" quick action, the
/// route passes `patient_uid` / `patient_id` / `name` / `phone` query
/// params; the form auto-fills the patient ID and shows a context chip
/// so the nurse doesn't re-key identification on every patient round.
class VitalsScreen extends StatefulWidget {
  final String? prefillPatientUid;
  final String? prefillPatientId;
  final String? prefillPatientName;
  final String? prefillPatientPhone;
  const VitalsScreen({
    super.key,
    this.prefillPatientUid,
    this.prefillPatientId,
    this.prefillPatientName,
    this.prefillPatientPhone,
  });

  @override
  State<VitalsScreen> createState() => _VitalsScreenState();
}

class _VitalsScreenState extends State<VitalsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final hasContext =
        (widget.prefillPatientName ?? '').isNotEmpty ||
        (widget.prefillPatientId ?? '').isNotEmpty;

    return StaffScaffold(
      title: s.vitalsTitle,
      body: Column(
        children: [
          if (hasContext)
            PatientContextChip(
              name: widget.prefillPatientName,
              phone: widget.prefillPatientPhone,
              accent: const Color(0xFFC62828),
            ),
          Container(
            color: AppTheme.cardSurface,
            child: TabBar(
              controller: _tabController,
              labelColor: const Color(0xFFC62828),
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: const Color(0xFFC62828),
              tabs: [
                Tab(text: s.vitalsTabRecord),
                Tab(text: s.vitalsTabRecent),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _RecordVitalsTab(
                  prefillPatientUid: widget.prefillPatientUid,
                  prefillPatientId: widget.prefillPatientId,
                  prefillPatientName: widget.prefillPatientName,
                ),
                const _RecentVitalsTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RecordVitalsTab extends StatefulWidget {
  final String? prefillPatientUid;
  final String? prefillPatientId;
  final String? prefillPatientName;
  const _RecordVitalsTab({
    this.prefillPatientUid,
    this.prefillPatientId,
    this.prefillPatientName,
  });

  @override
  State<_RecordVitalsTab> createState() => _RecordVitalsTabState();
}

class _DictateVitalsNotesIntent extends Intent {
  const _DictateVitalsNotesIntent();
}

class _RecordVitalsTabState extends State<_RecordVitalsTab> {
  final _formKey = GlobalKey<FormState>();
  final _patientIdCtrl = TextEditingController();
  final _notesDictationController = VoiceDictateButtonController();

  /// The positively-identified patient (STF-4). Vitals can only be
  /// submitted against this — never against free-typed text.
  Map<String, dynamic>? _confirmedPatient;
  bool _resolvingPatient = false;

  @override
  void initState() {
    super.initState();
    ConnectivitySyncService.instance.addListener(_connectivityChanged);
    final prefillId = int.tryParse((widget.prefillPatientId ?? '').trim());
    final prefillUid = (widget.prefillPatientUid ?? '').trim();
    if (prefillId != null) {
      // Opened from the bed board's per-patient quick action: the patient
      // was already positively identified there; carry that context over.
      _confirmedPatient = {
        'id': prefillId,
        if (prefillUid.isNotEmpty) 'uid': prefillUid,
        if ((widget.prefillPatientName ?? '').isNotEmpty)
          'name': widget.prefillPatientName,
      };
    } else if (prefillUid.isNotEmpty) {
      // UID-only prefill — resolve it to the numeric id + display identity.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_resolvePatient(scannedUid: prefillUid));
      });
    }
  }

  final _bpSysCtrl = TextEditingController();
  final _bpDiaCtrl = TextEditingController();
  final _tempCtrl = TextEditingController();
  final _pulseCtrl = TextEditingController();
  final _spo2Ctrl = TextEditingController();
  final _weightCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    ConnectivitySyncService.instance.removeListener(_connectivityChanged);
    _patientIdCtrl.dispose();
    _bpSysCtrl.dispose();
    _bpDiaCtrl.dispose();
    _tempCtrl.dispose();
    _pulseCtrl.dispose();
    _spo2Ctrl.dispose();
    _weightCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  void _connectivityChanged() {
    if (mounted) setState(() {});
  }

  void _focusNextField() {
    FocusScope.of(context).nextFocus();
  }

  void _submitFromField() {
    if (_submitting) return;
    _submit();
  }

  void _submitWhenNewline(TextEditingController controller, String value) {
    if (!value.contains('\n')) return;
    final cleaned = value.replaceAll(RegExp(r'\s*\n\s*'), ' ');
    controller.value = TextEditingValue(
      text: cleaned,
      selection: TextSelection.collapsed(offset: cleaned.length),
    );
    _submitFromField();
  }

  /// Resolve a scanned wristband UID or a manually-typed identifier to a
  /// positively-identified patient via the tenant-scoped patient search.
  Future<void> _resolvePatient({String? scannedUid, int? manualId}) async {
    if (_resolvingPatient) return;
    setState(() => _resolvingPatient = true);
    final strings = AppStrings.of(context);
    try {
      final query = scannedUid ?? 'VH-${manualId.toString().padLeft(6, '0')}';
      final rows = await PatientApiService.search(query);
      final match = resolveQuickVitalsPatient(
        rows,
        scannedUid: scannedUid,
        manualId: manualId,
      );
      if (!mounted) return;
      if (match == null) {
        ErrorToast.show(context, strings.vitalsScanNoMatch);
        return;
      }
      setState(() => _confirmedPatient = match);
    } catch (e) {
      if (mounted) ErrorToast.show(context, strings.vitalsScanResolveFailed);
    } finally {
      if (mounted) setState(() => _resolvingPatient = false);
    }
  }

  Future<void> _scanWristband() async {
    final strings = AppStrings.of(context);
    String? code;
    try {
      code = await showModalBottomSheet<String>(
        context: context,
        isScrollControlled: true,
        builder: (ctx) => const _WristbandScannerSheet(),
      );
    } catch (e) {
      if (mounted) ErrorToast.show(context, strings.vitalsScanCameraError);
      return;
    }
    final scanned = code?.trim() ?? '';
    if (scanned.isEmpty || !mounted) return;
    if (quickVitalsUuidRe.hasMatch(scanned)) {
      await _resolvePatient(scannedUid: scanned);
    } else if (int.tryParse(scanned) != null) {
      // Some wristbands carry the numeric hospital id — still verified
      // against the backend before confirmation.
      await _resolvePatient(manualId: int.parse(scanned));
    } else if (mounted) {
      ErrorToast.show(context, strings.vitalsScanNoMatch);
    }
  }

  Future<void> _verifyTypedPatient() async {
    final strings = AppStrings.of(context);
    final text = _patientIdCtrl.text.trim();
    if (quickVitalsUuidRe.hasMatch(text)) {
      // Keyboard-wedge scanners on desktop type the wristband UID here.
      await _resolvePatient(scannedUid: text);
      return;
    }
    final id = int.tryParse(text);
    if (id == null) {
      ErrorToast.show(context, strings.vitalsPatientIdInvalid);
      return;
    }
    await _resolvePatient(manualId: id);
  }

  Future<void> _submit() async {
    if (_submitting) return;
    if (!ConnectivitySyncService.instance.isOnline) {
      await _showOfflineVitalsRetirement();
      return;
    }
    if (!_formKey.currentState!.validate()) return;
    final confirmed = _confirmedPatient;
    final confirmedId = int.tryParse(patientIdFrom(confirmed));
    if (confirmed == null || confirmedId == null) {
      // Positive patient identification is mandatory (STF-4) — no
      // charting against a free-typed, unverified patient ID.
      ErrorToast.show(context, AppStrings.of(context).vitalsScanConfirmRequired);
      return;
    }
    setState(() => _submitting = true);
    final strings = AppStrings.of(context);
    try {
      final staffId = await ApiConfig.getStaffId();
      final vitalSigns = <String, dynamic>{};
      final measurements = <String, dynamic>{};

      final bpSys = normalizeVitalValue(_bpSysCtrl.text, VitalUnit.bp);
      final bpDia = normalizeVitalValue(_bpDiaCtrl.text, VitalUnit.bp);
      final temp = normalizeVitalValue(_tempCtrl.text, VitalUnit.temperature);
      final pulse = normalizeVitalValue(_pulseCtrl.text, VitalUnit.pulse);
      final spo2 = normalizeVitalValue(_spo2Ctrl.text, VitalUnit.spo2);
      final weight = normalizeVitalValue(_weightCtrl.text, VitalUnit.weight);

      if (bpSys.isNotEmpty && bpDia.isNotEmpty) {
        vitalSigns['blood_pressure'] = {
          'systolic': int.parse(bpSys),
          'diastolic': int.parse(bpDia),
        };
      }
      if (temp.isNotEmpty) {
        vitalSigns['temperature'] = double.parse(temp);
      }
      if (pulse.isNotEmpty) {
        vitalSigns['pulse'] = int.parse(pulse);
      }
      if (spo2.isNotEmpty) {
        vitalSigns['spo2'] = double.parse(spo2);
      }
      if (weight.isNotEmpty) {
        measurements['weight'] = double.parse(weight);
      }

      await MedicalApiService.recordVitals(
        patientId: confirmedId,
        vitalSigns: vitalSigns.isNotEmpty ? vitalSigns : null,
        measurements: measurements.isNotEmpty ? measurements : null,
        notes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
        recordedBy: staffId != null ? int.tryParse(staffId) : null,
      );
      if (mounted) {
        SuccessToast.show(context, strings.vitalsRecordedSuccess);
      }

      if (mounted) {
        _formKey.currentState!.reset();
        // Force a fresh positive identification for the next patient on the
        // round — never let one confirmation silently cover two patients.
        _confirmedPatient = null;
        _patientIdCtrl.clear();
        _bpSysCtrl.clear();
        _bpDiaCtrl.clear();
        _tempCtrl.clear();
        _pulseCtrl.clear();
        _spo2Ctrl.clear();
        _weightCtrl.clear();
        _notesCtrl.clear();
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString());
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _showOfflineVitalsRetirement() {
    final strings = AppStrings.of(context);
    return showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        icon: const Icon(Icons.description_outlined),
        title: Text(strings.vitalsOfflineRetiredTitle),
        content: Text(strings.vitalsOfflineRetiredMessage),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: Text(strings.actionClose),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final isOnline = ConnectivitySyncService.instance.isOnline;
    final content = SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFFC62828), Color(0xFFE53935)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: [
                const Icon(Icons.monitor_heart, color: Colors.white, size: 36),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.vitalsHeaderTitle,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold,
                          fontSize: 16,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        s.vitalsHeaderSubtitle,
                        style: const TextStyle(
                          color: Colors.white70,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          if (!isOnline) ...[
            Semantics(
              liveRegion: true,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppTheme.warningAmber.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppTheme.warningAmber),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(
                      Icons.description_outlined,
                      color: AppTheme.warningAmber,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            s.vitalsOfflineRetiredTitle,
                            style: Theme.of(context).textTheme.titleSmall
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                          const SizedBox(height: 4),
                          Text(s.vitalsOfflineRetiredMessage),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
          ],

          FocusTraversalGroup(
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Positive patient identification (STF-4): wristband scan
                  // is the primary path; a typed identifier must be verified
                  // against the backend before anything can be charted.
                  if (_confirmedPatient != null)
                    _ConfirmedPatientCard(
                      patient: _confirmedPatient!,
                      onChangePatient: () =>
                          setState(() => _confirmedPatient = null),
                    )
                  else ...[
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        onPressed: _resolvingPatient ? null : _scanWristband,
                        icon: const Icon(Icons.qr_code_scanner),
                        label: Text(s.vitalsScanWristbandButton),
                        style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFFC62828),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: TextFormField(
                            controller: _patientIdCtrl,
                            keyboardType: TextInputType.number,
                            textInputAction: TextInputAction.done,
                            onFieldSubmitted: (_) =>
                                unawaited(_verifyTypedPatient()),
                            decoration: InputDecoration(
                              labelText: s.vitalsPatientIdLabel,
                              hintText: s.vitalsPatientIdHint,
                              prefixIcon: const ExcludeSemantics(
                                child: Icon(Icons.person_outlined),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: OutlinedButton(
                            onPressed: _resolvingPatient
                                ? null
                                : () => unawaited(_verifyTypedPatient()),
                            child: _resolvingPatient
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : Text(s.vitalsScanVerifyButton),
                          ),
                        ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 20),

                  // Blood Pressure
                  _SectionHeader(
                    icon: Icons.favorite,
                    label: s.vitalsBpHeader,
                    color: const Color(0xFFC62828),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: TextFormField(
                          controller: _bpSysCtrl,
                          keyboardType: TextInputType.number,
                          textInputAction: TextInputAction.next,
                          onFieldSubmitted: (_) => _focusNextField(),
                          decoration: InputDecoration(
                            labelText: s.vitalsBpSystolic,
                            hintText: s.vitalsBpSystolicHint,
                            suffixText: VitalUnit.bp,
                          ),
                          validator: (v) {
                            if (v == null || v.isEmpty) return null;
                            final n = int.tryParse(
                              normalizeVitalValue(v, VitalUnit.bp),
                            );
                            if (n == null || n < 60 || n > 300) {
                              return s.vitalsValidationInvalid;
                            }
                            return null;
                          },
                        ),
                      ),
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 10),
                        child: Text('/', style: TextStyle(fontSize: 24)),
                      ),
                      Expanded(
                        child: TextFormField(
                          controller: _bpDiaCtrl,
                          keyboardType: TextInputType.number,
                          textInputAction: TextInputAction.next,
                          onFieldSubmitted: (_) => _focusNextField(),
                          decoration: InputDecoration(
                            labelText: s.vitalsBpDiastolic,
                            hintText: s.vitalsBpDiastolicHint,
                            suffixText: VitalUnit.bp,
                          ),
                          validator: (v) {
                            if (v == null || v.isEmpty) return null;
                            final n = int.tryParse(
                              normalizeVitalValue(v, VitalUnit.bp),
                            );
                            if (n == null || n < 30 || n > 200) {
                              return s.vitalsValidationInvalid;
                            }
                            return null;
                          },
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Temperature
                  _SectionHeader(
                    icon: Icons.thermostat,
                    label: s.vitalsTemperatureHeader,
                    color: const Color(0xFFE65100),
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    controller: _tempCtrl,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    textInputAction: TextInputAction.next,
                    onFieldSubmitted: (_) => _focusNextField(),
                    decoration: InputDecoration(
                      labelText: s.vitalsTemperatureHeader,
                      hintText: s.vitalsTemperatureHint,
                      suffixText: VitalUnit.temperature,
                      prefixIcon: const ExcludeSemantics(
                        child: Icon(Icons.thermostat_outlined),
                      ),
                    ),
                    validator: (v) {
                      if (v == null || v.isEmpty) return null;
                      final n = double.tryParse(
                        normalizeVitalValue(v, VitalUnit.temperature),
                      );
                      if (n == null || n < 90 || n > 115) {
                        return s.vitalsValidationInvalid;
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 20),

                  // Pulse & SpO2
                  _SectionHeader(
                    icon: Icons.speed,
                    label: s.vitalsPulseSpo2Header,
                    color: const Color(0xFF0097A7),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: TextFormField(
                          controller: _pulseCtrl,
                          keyboardType: TextInputType.number,
                          textInputAction: TextInputAction.next,
                          onFieldSubmitted: (_) => _focusNextField(),
                          decoration: InputDecoration(
                            labelText: s.vitalsPulseLabel,
                            hintText: s.vitalsPulseHint,
                            suffixText: VitalUnit.pulse,
                            prefixIcon: const ExcludeSemantics(
                              child: Icon(Icons.speed_outlined),
                            ),
                          ),
                          validator: (v) {
                            if (v == null || v.isEmpty) return null;
                            final n = int.tryParse(
                              normalizeVitalValue(v, VitalUnit.pulse),
                            );
                            if (n == null || n < 20 || n > 250) {
                              return s.vitalsValidationInvalid;
                            }
                            return null;
                          },
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: TextFormField(
                          controller: _spo2Ctrl,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          textInputAction: TextInputAction.next,
                          onFieldSubmitted: (_) => _focusNextField(),
                          decoration: InputDecoration(
                            labelText: s.vitalsSpo2Label,
                            hintText: s.vitalsSpo2Hint,
                            suffixText: VitalUnit.spo2,
                            prefixIcon: const ExcludeSemantics(
                              child: Icon(Icons.air_outlined),
                            ),
                          ),
                          validator: (v) {
                            if (v == null || v.isEmpty) return null;
                            final n = double.tryParse(
                              normalizeVitalValue(v, VitalUnit.spo2),
                            );
                            if (n == null || n < 50 || n > 100) {
                              return s.vitalsValidationInvalid;
                            }
                            return null;
                          },
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Weight
                  _SectionHeader(
                    icon: Icons.monitor_weight,
                    label: s.vitalsWeightHeader,
                    color: const Color(0xFF2E7D32),
                  ),
                  const SizedBox(height: 10),
                  TextFormField(
                    controller: _weightCtrl,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    textInputAction: TextInputAction.next,
                    onFieldSubmitted: (_) => _focusNextField(),
                    decoration: InputDecoration(
                      labelText: s.vitalsWeightHeader,
                      hintText: s.vitalsWeightHint,
                      suffixText: VitalUnit.weight,
                      prefixIcon: const ExcludeSemantics(
                        child: Icon(Icons.monitor_weight_outlined),
                      ),
                    ),
                    validator: (v) {
                      if (v == null || v.isEmpty) return null;
                      final n = double.tryParse(
                        normalizeVitalValue(v, VitalUnit.weight),
                      );
                      if (n == null || n < 1 || n > 500) {
                        return s.vitalsValidationInvalid;
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 20),

                  // Notes
                  TextFormField(
                    controller: _notesCtrl,
                    keyboardType: TextInputType.text,
                    textInputAction: TextInputAction.done,
                    onFieldSubmitted: (_) => _submitFromField(),
                    onChanged: (value) => _submitWhenNewline(_notesCtrl, value),
                    decoration: InputDecoration(
                      labelText: s.vitalsNurseNotesLabel,
                      hintText: s.vitalsNurseNotesHint,
                      prefixIcon: const ExcludeSemantics(
                        child: Icon(Icons.notes_outlined),
                      ),
                      suffixIcon: VoiceDictateButton(
                        controller: _notesCtrl,
                        patientUid: widget.prefillPatientUid,
                        dictateController: _notesDictationController,
                      ),
                      alignLabelWithHint: true,
                    ),
                    maxLines: 3,
                  ),
                  const SizedBox(height: 24),

                  ElevatedButton.icon(
                    onPressed: _submitting
                        ? null
                        : isOnline
                        ? _submit
                        : _showOfflineVitalsRetirement,
                    icon: _submitting
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              color: Colors.white,
                              strokeWidth: 2,
                            ),
                          )
                        : Icon(
                            isOnline ? Icons.save : Icons.description_outlined,
                            color: Colors.white,
                          ),
                    label: Text(
                      _submitting
                          ? s.bedSheetSavingLabel
                          : isOnline
                          ? s.vitalsSaveButton
                          : s.vitalsOfflinePaperButton,
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFC62828),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );

    return Shortcuts(
      shortcuts: const <ShortcutActivator, Intent>{
        SingleActivator(LogicalKeyboardKey.keyM, control: true):
            _DictateVitalsNotesIntent(),
      },
      child: Actions(
        actions: <Type, Action<Intent>>{
          _DictateVitalsNotesIntent: CallbackAction<_DictateVitalsNotesIntent>(
            onInvoke: (_) {
              unawaited(_notesDictationController.start());
              return null;
            },
          ),
        },
        child: content,
      ),
    );
  }
}

class _RecentVitalsTab extends StatefulWidget {
  const _RecentVitalsTab();

  @override
  State<_RecentVitalsTab> createState() => _RecentVitalsTabState();
}

class _RecentVitalsTabState extends State<_RecentVitalsTab> {
  final _patientIdCtrl = TextEditingController();
  Map<String, dynamic>? _trends;
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _patientIdCtrl.dispose();
    super.dispose();
  }

  Future<void> _fetchTrends() async {
    final s = AppStrings.of(context);
    final id = int.tryParse(_patientIdCtrl.text.trim());
    if (id == null) {
      setState(() => _error = s.vitalsPatientIdInvalid);
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
      _trends = null;
    });
    try {
      final data = await MedicalApiService.getPatientVitalTrends(id);
      if (mounted) setState(() => _trends = data);
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _patientIdCtrl,
                  keyboardType: TextInputType.number,
                  decoration: InputDecoration(
                    labelText: s.vitalsPatientIdLabel,
                    hintText: s.vitalsPatientIdHint,
                    prefixIcon: const ExcludeSemantics(
                      child: Icon(Icons.person_search_outlined),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              ElevatedButton(
                onPressed: _loading ? null : _fetchTrends,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFFC62828),
                ),
                child: _loading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          color: Colors.white,
                          strokeWidth: 2,
                        ),
                      )
                    : Text(s.vitalsFetchButton),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (_error != null)
            Expanded(
              child: ErrorState(message: _error!, onRetry: _fetchTrends),
            ),
          if (_trends != null && _error == null)
            Expanded(child: _buildTrendsView(_trends!)),
          if (_trends == null && !_loading && _error == null)
            Expanded(
              child: EmptyState(
                icon: Icons.timeline_outlined,
                title: s.vitalsTrendsHint,
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildTrendsView(Map<String, dynamic> data) {
    final s = AppStrings.of(context);
    final records =
        data['records'] as List? ??
        data['trends'] as List? ??
        data['vital_trends'] as List? ??
        [];

    if (records.isEmpty) {
      return EmptyState(
        icon: Icons.monitor_heart_outlined,
        title: s.vitalsNoRecords,
      );
    }

    return ListView.builder(
      itemCount: records.length,
      itemBuilder: (_, i) {
        final r = records[i] as Map<String, dynamic>;
        final vitals = r['vital_signs'] as Map<String, dynamic>? ?? {};
        final measurements = r['measurements'] as Map<String, dynamic>? ?? {};
        final date =
            r['created_at']?.toString() ??
            r['recorded_at']?.toString() ??
            r['date']?.toString() ??
            '';

        return Card(
          margin: const EdgeInsets.only(bottom: 10),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.monitor_heart,
                      size: 18,
                      color: Color(0xFFC62828),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        date,
                        style: TextStyle(
                          fontSize: 12,
                          color: AppTheme.textSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 16,
                  runSpacing: 8,
                  children: [
                    if (vitals['blood_pressure'] != null)
                      _VitalChip(
                        s.vitalsChartColBp,
                        '${vitals['blood_pressure']['systolic']}/${vitals['blood_pressure']['diastolic']}',
                        VitalUnit.bp,
                      ),
                    if (vitals['temperature'] != null)
                      _VitalChip(
                        s.vitalsChartColTemp,
                        '${vitals['temperature']}',
                        VitalUnit.temperature,
                      ),
                    if (vitals['pulse'] != null)
                      _VitalChip(
                        s.vitalsPulseLabel,
                        '${vitals['pulse']}',
                        VitalUnit.pulse,
                      ),
                    if (vitals['spo2'] != null)
                      _VitalChip(
                        s.vitalsSpo2Label,
                        '${vitals['spo2']}',
                        VitalUnit.spo2,
                      ),
                    if (measurements['weight'] != null)
                      _VitalChip(
                        s.vitalsWeightHeader,
                        '${measurements['weight']}',
                        VitalUnit.weight,
                      ),
                  ],
                ),
                if (r['notes'] != null && r['notes'].toString().isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    r['notes'].toString(),
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

/// Confirmation card for the positively-identified patient: shows name +
/// identifiers so the nurse verifies against the wristband/bed card before
/// charting, with an explicit way to start over.
class _ConfirmedPatientCard extends StatelessWidget {
  const _ConfirmedPatientCard({
    required this.patient,
    required this.onChangePatient,
  });

  final Map<String, dynamic> patient;
  final VoidCallback onChangePatient;

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final name = patientNameFrom(patient);
    final hospitalNumber = patientHospitalNumberFrom(patient);
    final phone = patientPhoneFrom(patient);
    final id = patientIdFrom(patient);
    final details = [
      if (hospitalNumber.isNotEmpty) hospitalNumber else if (id.isNotEmpty) id,
      if (phone.isNotEmpty) phone,
    ].join(' · ');

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.successGreen.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.successGreen),
      ),
      child: Row(
        children: [
          const Icon(Icons.verified_user, color: AppTheme.successGreen),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.vitalsScanVerifiedLabel,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: AppTheme.textSecondary,
                  ),
                ),
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (details.isNotEmpty)
                  Text(
                    details,
                    style: TextStyle(
                      fontSize: 12,
                      color: AppTheme.textSecondary,
                    ),
                  ),
              ],
            ),
          ),
          TextButton(
            onPressed: onChangePatient,
            child: Text(s.vitalsScanChangePatient),
          ),
        ],
      ),
    );
  }
}

/// Camera sheet for the wristband scan — same mobile_scanner flow the MAR
/// 5-rights screen uses. Pops with the first non-empty barcode payload.
class _WristbandScannerSheet extends StatefulWidget {
  const _WristbandScannerSheet();

  @override
  State<_WristbandScannerSheet> createState() => _WristbandScannerSheetState();
}

class _WristbandScannerSheetState extends State<_WristbandScannerSheet> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _popped = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_popped) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null || raw.trim().isEmpty) return;
    _popped = true;
    Navigator.of(context).pop(raw.trim());
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              s.vitalsScanWristbandButton,
              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            Text(
              s.vitalsScanSubtitle,
              style: TextStyle(fontSize: 13, color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 12),
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: SizedBox(
                height: 320,
                child: MobileScanner(
                  controller: _controller,
                  onDetect: _onDetect,
                  errorBuilder: (context, error) => ColoredBox(
                    color: AppTheme.backgroundGrey,
                    child: Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          s.vitalsScanCameraError,
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: Text(AppStrings.of(context).actionCancel),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _VitalChip extends StatelessWidget {
  final String label;
  final String value;
  final String unit;
  const _VitalChip(this.label, this.value, this.unit);

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(
            fontSize: 10,
            color: AppTheme.textSecondary,
            fontWeight: FontWeight.w500,
          ),
        ),
        Text(
          vitalValueWithUnit(value, unit),
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.bold,
            color: AppTheme.textPrimary,
          ),
        ),
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;

  const _SectionHeader({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 8),
        Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
      ],
    );
  }
}
