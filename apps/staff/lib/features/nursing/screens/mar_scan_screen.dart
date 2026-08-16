import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';
import 'package:vhhealth_core/services/mar_five_rights.dart';
import 'package:vhhealth_core/services/mar_offline_cache.dart';
// OfflineSyncBadge is already mounted by StaffScaffold's AppBar actions
// (see core/widgets/staff_scaffold.dart), so this screen inherits it — no
// second badge is added here to avoid a duplicate in the app bar.

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/offline_clinical_fallback_dialog.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../mar_offline_administer.dart';

@visibleForTesting
Future<void> showMarAdministrationOfflineFallback(BuildContext context) {
  final s = AppStrings.of(context);
  return showOfflineClinicalFallbackDialog(
    context,
    paperFormSet: s.offlineClinicalFallbackMarSheets,
  );
}

/// Bedside medication administration with 5-rights barcode verification.
///
/// The flow is a four-step linear state machine:
///
///   1. [_Step.scanWristband]  — camera live-view. On any QR/barcode, the
///       payload is stored as the patient UID.
///   2. [_Step.scanDrug]       — scan the drug label/NDC.
///   3. [_Step.verify]         — POST /clinical/mar/verify; render a per-right
///      checkmark/cross. If all pass → Administer button. If any fails →
///      Override button that reveals a reason field.
///   4. [_Step.done]            — administration committed; show success with
///      option to scan next.
///
/// Pre-requisite: the screen needs a `ma_id` (medication_administrations.id)
/// that's already been scheduled for this patient. That's passed in via the
/// constructor — callers typically pick it from a "due meds" list.
class MarScanScreen extends StatefulWidget {
  const MarScanScreen({super.key, required this.maId});

  /// The medication_administrations row ID to administer against.
  final int maId;

  @override
  State<MarScanScreen> createState() => _MarScanScreenState();
}

enum _Step { scanWristband, scanDrug, verify, done }

/// Wrong-patient / wrong-drug are non-overridable BCMA never-events (audit
/// 2026-06-22 F-H1). When `/clinical/mar/verify` explicitly fails the patient
/// or drug right, the nurse must RE-SCAN — there is no justify-and-proceed. The
/// backend enforces the same with a MAR_PATIENT_MISMATCH / MAR_DRUG_MISMATCH
/// hard-stop; this client guard avoids leading the nurse into an override box
/// the server will refuse. Only the soft rights (dose/route/time) are overridable.
bool marIsIdentityMismatch(Map<String, dynamic> rights) {
  return rights['patient'] == false || rights['drug'] == false;
}

class _MarScanScreenState extends State<MarScanScreen> {
  _Step _step = _Step.scanWristband;
  String? _patientUid;
  String? _barcode;

  Map<String, dynamic>? _verifyResult;
  bool _busy = false;
  String? _errorMessage;

  final MobileScannerController _scannerController = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _scanLock = false;

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  void _onScan(BarcodeCapture capture) {
    if (_scanLock) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null || raw.isEmpty) return;
    _scanLock = true;
    setState(() {
      if (_step == _Step.scanWristband) {
        _patientUid = raw.trim();
        _step = _Step.scanDrug;
      } else if (_step == _Step.scanDrug) {
        _barcode = raw.trim();
        _runVerify();
      }
    });
    // Debounce further scans; mobile_scanner's noDuplicates helps but a short
    // delay prevents the next frame from re-firing while the state transitions.
    Future.delayed(const Duration(milliseconds: 600), () => _scanLock = false);
  }

  Future<void> _runVerify() async {
    setState(() {
      _step = _Step.verify;
      _busy = true;
      _errorMessage = null;
    });
    try {
      if (!ConnectivitySyncService.instance.isOnline) {
        await _runVerifyOffline();
        return;
      }
      final result = await MedicalApiService.verify5Rights(
        maId: widget.maId,
        scannedPatientUid: _patientUid!,
        scannedBarcode: _barcode!,
      );
      setState(() => _verifyResult = result);
    } catch (e) {
      setState(
        () => _errorMessage = e.toString().replaceFirst('Exception: ', ''),
      );
    } finally {
      setState(() => _busy = false);
    }
  }

  /// Offline 5-rights: verify against the encrypted cached dose using the same
  /// client-side check the queued administer will use. Shapes [_verifyResult]
  /// to mirror the server's `{rights, allPassed, ma}` envelope so the existing
  /// verify-panel rendering works unchanged.
  Future<void> _runVerifyOffline() async {
    final dose = await MarOfflineCache.getCachedDose(_patientUid!, widget.maId);
    if (dose == null) {
      await _showAndRetainMarFallback();
      return;
    }
    final rights = evaluateFiveRights(
      dose: dose,
      scannedPatientUid: _patientUid!,
      scannedBarcode: _barcode!,
      at: DateTime.now().toUtc(),
    );
    setState(() {
      _verifyResult = {
        'rights': rights.toMap(),
        'allPassed': rights.allPassed,
        'ma': {
          'medication_name': dose['medication_name'],
          'dose': dose['dose'] ?? dose['dosage'],
          'route': dose['route'],
        },
      };
    });
  }

  Future<void> _administer({String? overrideReason}) async {
    setState(() {
      _busy = true;
      _errorMessage = null;
    });
    try {
      if (!ConnectivitySyncService.instance.isOnline) {
        await _administerOffline();
        return;
      }
      await MedicalApiService.administerWithScan(
        maId: widget.maId,
        scannedPatientUid: _patientUid!,
        scannedBarcode: _barcode!,
        overrideReason: overrideReason,
        // Record the true bedside time; harmless online — the server COALESCEs.
        administeredAt: DateTime.now().toUtc(),
      );
      if (!mounted) return;
      setState(() => _step = _Step.done);
    } catch (e) {
      setState(
        () => _errorMessage = e.toString().replaceFirst('Exception: ', ''),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Offline administer: re-run the pure safety decision against the cached
  /// dose. Identity mismatches remain hard stops; otherwise the clinical action
  /// is not recorded or queued and the nurse is directed to the MAR paper set.
  Future<void> _administerOffline() async {
    final dose = await MarOfflineCache.getCachedDose(_patientUid!, widget.maId);
    if (dose == null) {
      await _showAndRetainMarFallback();
      return;
    }
    final intent = buildOfflineAdministerIntent(
      dose: dose,
      scannedPatientUid: _patientUid!,
      scannedBarcode: _barcode!,
      at: DateTime.now().toUtc(),
    );
    if (intent.hardStop) {
      // Wrong-patient / wrong-drug never-event — re-scan, no write queued.
      setState(
        () => _errorMessage =
            'Patient/drug mismatch — administration blocked. Re-scan.',
      );
      return;
    }
    await _showAndRetainMarFallback();
  }

  Future<void> _showAndRetainMarFallback() async {
    if (!mounted) return;
    final s = AppStrings.of(context);
    await showMarAdministrationOfflineFallback(context);
    if (!mounted) return;
    setState(
      () => _errorMessage = s.offlineClinicalFallbackMessage(
        s.offlineClinicalFallbackMarSheets,
      ),
    );
  }

  void _reset() {
    setState(() {
      _step = _Step.scanWristband;
      _patientUid = null;
      _barcode = null;
      _verifyResult = null;
      _errorMessage = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(title: s.marScanTitle, body: _buildBody(s));
  }

  Widget _buildBody(AppStrings s) {
    switch (_step) {
      case _Step.scanWristband:
        return _scanPanel(
          prompt: s.marScanStep1Prompt,
          subtitle: s.marScanStep1Subtitle,
        );
      case _Step.scanDrug:
        return _scanPanel(
          prompt: s.marScanStep2Prompt,
          subtitle: s.marScanStep2Subtitle,
        );
      case _Step.verify:
        return _verifyPanel(s);
      case _Step.done:
        return _donePanel(s);
    }
  }

  Widget _scanPanel({required String prompt, required String subtitle}) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                prompt,
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 16,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                subtitle,
                style: const TextStyle(fontSize: 13, color: Colors.black54),
              ),
            ],
          ),
        ),
        Expanded(
          child: MobileScanner(
            controller: _scannerController,
            onDetect: _onScan,
          ),
        ),
      ],
    );
  }

  Widget _verifyPanel(AppStrings s) {
    if (_busy && _verifyResult == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_errorMessage != null && _verifyResult == null) {
      return _errorView(_errorMessage!, s);
    }
    final r = _verifyResult;
    if (r == null) return const SizedBox.shrink();
    final rights = (r['rights'] as Map?)?.cast<String, dynamic>() ?? const {};
    final allPassed = r['allPassed'] == true;
    final ma = (r['ma'] as Map?)?.cast<String, dynamic>() ?? const {};

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            s.marScanStep3Header,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.03),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  ma['medication_name']?.toString() ??
                      s.marScanUnknownMedication,
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                Text(
                  'Dose: ${ma['dose'] ?? '-'} · Route: ${ma['route'] ?? '-'}',
                  style: const TextStyle(fontSize: 13),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _rightRow(s.marScanRightPatient, rights['patient'] == true),
          _rightRow(s.marScanRightDrug, rights['drug'] == true),
          _rightRow(s.marScanRightDose, rights['dose'] == true),
          _rightRow(s.marScanRightRoute, rights['route'] == true),
          _rightRow(s.marScanRightTime, rights['time'] == true),
          const SizedBox(height: 20),
          if (marIsIdentityMismatch(rights))
            // Wrong-patient / wrong-drug: hard-stop, no override (audit F-H1).
            _marHardStopPanel(s, rights)
          else if (!ConnectivitySyncService.instance.isOnline)
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: _busy ? null : () => _administer(),
                icon: const Icon(Icons.assignment_outlined),
                label: Text(s.offlineClinicalFallbackTitle),
              ),
            )
          else if (allPassed)
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.successGreen,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
                onPressed: _busy ? null : () => _administer(),
                icon: const Icon(Icons.check_circle),
                label: Text(_busy ? s.marScanRecording : s.marScanAdminister),
              ),
            )
          else
            _OverrideSection(
              onOverride: (reason) => _administer(overrideReason: reason),
              busy: _busy,
            ),
          if (_errorMessage != null) ...[
            const SizedBox(height: 12),
            Text(_errorMessage!, style: const TextStyle(color: Colors.red)),
          ],
          TextButton(onPressed: _reset, child: Text(s.marScanScanAgain)),
        ],
      ),
    );
  }

  Widget _marHardStopPanel(AppStrings s, Map<String, dynamic> rights) {
    final reasons = <String>[
      if (rights['patient'] == false) s.marScanHardStopPatient,
      if (rights['drug'] == false) s.marScanHardStopDrug,
    ];
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppTheme.errorRed.withValues(alpha: 0.10),
        border: Border.all(color: AppTheme.errorRed),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.block, color: AppTheme.errorRed),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  s.marScanHardStopTitle,
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    color: AppTheme.errorRed,
                    fontSize: 15,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          for (final r in reasons)
            Padding(
              padding: const EdgeInsets.only(left: 32, bottom: 4),
              child: Text('• $r', style: const TextStyle(fontSize: 13)),
            ),
          Padding(
            padding: const EdgeInsets.only(left: 32, top: 2),
            child: Text(
              s.marScanHardStopBody,
              style: TextStyle(fontSize: 13, color: AppTheme.textSecondary),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.errorRed,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onPressed: _reset,
              icon: const Icon(Icons.qr_code_scanner),
              label: Text(s.marScanScanAgain),
            ),
          ),
        ],
      ),
    );
  }

  Widget _rightRow(String label, bool passed) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Icon(
            passed ? Icons.check_circle : Icons.cancel,
            color: passed ? AppTheme.successGreen : AppTheme.errorRed,
          ),
          const SizedBox(width: 8),
          Text(label, style: const TextStyle(fontSize: 14)),
        ],
      ),
    );
  }

  Widget _donePanel(AppStrings s) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.check_circle,
              color: AppTheme.successGreen,
              size: 72,
            ),
            const SizedBox(height: 12),
            Text(
              s.marScanRecorded,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 24),
            ElevatedButton(onPressed: _reset, child: Text(s.marScanScanNext)),
          ],
        ),
      ),
    );
  }

  Widget _errorView(String msg, AppStrings s) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: Colors.red, size: 48),
            const SizedBox(height: 12),
            Text(msg, textAlign: TextAlign.center),
            const SizedBox(height: 24),
            ElevatedButton(onPressed: _reset, child: Text(s.marScanTryAgain)),
          ],
        ),
      ),
    );
  }
}

/// Override categories for the MAR 5-rights check. Each maps to a stable
/// audit string sent to the backend as part of the override_reason payload.
enum _MarOverrideCategory {
  patientRefused('patient-refused', 'Patient refused per order'),
  clinicalJudgement('clinical-judgement', 'Clinical judgement override'),
  doseAdjustedPerOrder('dose-adjusted-per-order', 'Dose adjusted per order'),
  timingVariance('timing-variance', 'Timing variance — within window'),
  documentationCorrection(
    'documentation-correction',
    'Documentation correction',
  ),
  other('other', 'Other (specify below)');

  const _MarOverrideCategory(this.value, this.label);
  final String value;
  final String label;
}

/// Returns true if the text is meaningfully written — rejects all-whitespace,
/// single-character repeats (e.g. "aaaaa"), and anything under [minLength].
bool _isMeaningfulText(String text, {int minLength = 15}) {
  final t = text.trim();
  if (t.length < minLength) return false;
  // Reject strings made of a single repeated character (e.g. "aaaaaaaaaaaaa").
  // We compare every code unit to the first, which is correct for ASCII-range
  // repeat-character patterns (the most common gaming attempt).
  if (t.isNotEmpty && t.codeUnits.every((u) => u == t.codeUnitAt(0))) {
    return false;
  }
  return true;
}

class _OverrideSection extends StatefulWidget {
  const _OverrideSection({required this.onOverride, required this.busy});
  final void Function(String reason) onOverride;
  final bool busy;

  @override
  State<_OverrideSection> createState() => _OverrideSectionState();
}

class _OverrideSectionState extends State<_OverrideSection> {
  _MarOverrideCategory? _category;
  final TextEditingController _justification = TextEditingController();

  @override
  void dispose() {
    _justification.dispose();
    super.dispose();
  }

  bool get _valid {
    if (_category == null) return false;
    final text = _justification.text;
    // "other" requires a non-empty justification regardless.
    if (_category == _MarOverrideCategory.other && text.trim().isEmpty) {
      return false;
    }
    return _isMeaningfulText(text);
  }

  /// Builds the structured override_reason string sent to the backend.
  /// Format: "[category-value] justification text"
  /// This is parseable by the audit system while remaining a single string
  /// that the backend override_reason column already accepts.
  String get _payload {
    final cat = _category!.value;
    final just = _justification.text.trim();
    return '[$cat] $just';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.orange.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.orange.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            AppStrings.of(context).marScanCheckFailed,
            style: const TextStyle(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 4),
          Text(
            AppStrings.of(context).marScanOverrideHint,
            style: const TextStyle(fontSize: 12),
          ),
          const SizedBox(height: 12),
          // ── Step 1: structured category ──
          DropdownButtonFormField<_MarOverrideCategory>(
            decoration: InputDecoration(
              labelText: AppStrings.of(context)
                  .lookup('s4.lib.cds_blocker_modal.override_category'),
              border: const OutlineInputBorder(),
              isDense: true,
            ),
            initialValue: _category,
            hint: const AppText('s4.lib.mar_scan.select_a_category'),
            items: _MarOverrideCategory.values
                .map((c) => DropdownMenuItem(value: c, child: Text(c.label)))
                .toList(),
            onChanged: (v) => setState(() => _category = v),
          ),
          const SizedBox(height: 10),
          // ── Step 2: free-text justification ──
          TextField(
            controller: _justification,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: AppStrings.of(context)
                  .lookup('s4.lib.cds_blocker_modal.clinical_justification'),
              hintText: AppStrings.of(context).lookup(
                's4.lib.mar_scan.min_15_characters_describe_the_specific_situatio',
              ),
              border: const OutlineInputBorder(),
              // Live validation indicator
              suffixIcon: _justification.text.isEmpty
                  ? null
                  : Icon(
                      _isMeaningfulText(_justification.text)
                          ? Icons.check_circle_outline
                          : Icons.error_outline,
                      color: _isMeaningfulText(_justification.text)
                          ? AppTheme.successGreen
                          : AppTheme.errorRed,
                      size: 18,
                    ),
            ),
            onChanged: (_) => setState(() {}),
          ),
          if (_justification.text.trim().isNotEmpty &&
              !_isMeaningfulText(_justification.text)) ...[
            const SizedBox(height: 4),
            Text(
              _justification.text.trim().length < 15
                  ? 'Minimum 15 characters required'
                  : 'Justification must not be a repeated character',
              style: const TextStyle(fontSize: 11, color: AppTheme.errorRed),
            ),
          ],
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.errorRed,
                foregroundColor: Colors.white,
              ),
              onPressed: (!_valid || widget.busy)
                  ? null
                  : () => widget.onOverride(_payload),
              child: Text(
                widget.busy
                    ? AppStrings.of(context).marScanRecording
                    : AppStrings.of(context).marScanOverrideButton,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
