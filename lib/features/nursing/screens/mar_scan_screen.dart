import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

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
      final result = await MedicalApiService.verify5Rights(
        maId: widget.maId,
        scannedPatientUid: _patientUid!,
        scannedBarcode: _barcode!,
      );
      setState(() => _verifyResult = result);
    } catch (e) {
      setState(() => _errorMessage = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      setState(() => _busy = false);
    }
  }

  Future<void> _administer({String? overrideReason}) async {
    setState(() {
      _busy = true;
      _errorMessage = null;
    });
    try {
      await MedicalApiService.administerWithScan(
        maId: widget.maId,
        scannedPatientUid: _patientUid!,
        scannedBarcode: _barcode!,
        overrideReason: overrideReason,
      );
      if (!mounted) return;
      setState(() => _step = _Step.done);
    } catch (e) {
      setState(() => _errorMessage = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
    return StaffScaffold(
      title: 'Administer Medication',
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    switch (_step) {
      case _Step.scanWristband:
        return _scanPanel(
          prompt: 'Step 1 of 3 — Scan patient wristband',
          subtitle: 'Point the camera at the QR code on the patient\'s wristband.',
        );
      case _Step.scanDrug:
        return _scanPanel(
          prompt: 'Step 2 of 3 — Scan drug barcode',
          subtitle: 'Now scan the barcode on the medication label.',
        );
      case _Step.verify:
        return _verifyPanel();
      case _Step.done:
        return _donePanel();
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
              Text(prompt, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              const SizedBox(height: 4),
              Text(subtitle, style: const TextStyle(fontSize: 13, color: Colors.black54)),
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

  Widget _verifyPanel() {
    if (_busy && _verifyResult == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_errorMessage != null && _verifyResult == null) {
      return _errorView(_errorMessage!);
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
          Text('Step 3 of 3 — 5-rights check',
              style: Theme.of(context).textTheme.titleMedium),
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
                Text(ma['medication_name']?.toString() ?? '(unknown medication)',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                Text('Dose: ${ma['dose'] ?? '-'} · Route: ${ma['route'] ?? '-'}',
                    style: const TextStyle(fontSize: 13)),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _rightRow('Right patient', rights['patient'] == true),
          _rightRow('Right drug', rights['drug'] == true),
          _rightRow('Right dose', rights['dose'] == true),
          _rightRow('Right route', rights['route'] == true),
          _rightRow('Right time', rights['time'] == true),
          const SizedBox(height: 20),
          if (allPassed)
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
                label: Text(_busy ? 'Recording…' : 'Administer'),
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
          TextButton(onPressed: _reset, child: const Text('Scan again')),
        ],
      ),
    );
  }

  Widget _rightRow(String label, bool passed) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Icon(passed ? Icons.check_circle : Icons.cancel,
              color: passed ? AppTheme.successGreen : AppTheme.errorRed),
          const SizedBox(width: 8),
          Text(label, style: const TextStyle(fontSize: 14)),
        ],
      ),
    );
  }

  Widget _donePanel() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.check_circle, color: AppTheme.successGreen, size: 72),
            const SizedBox(height: 12),
            const Text('Administration recorded',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 24),
            ElevatedButton(onPressed: _reset, child: const Text('Scan next dose')),
          ],
        ),
      ),
    );
  }

  Widget _errorView(String msg) {
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
            ElevatedButton(onPressed: _reset, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

class _OverrideSection extends StatefulWidget {
  const _OverrideSection({required this.onOverride, required this.busy});
  final void Function(String reason) onOverride;
  final bool busy;

  @override
  State<_OverrideSection> createState() => _OverrideSectionState();
}

class _OverrideSectionState extends State<_OverrideSection> {
  final TextEditingController _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final valid = _reason.text.trim().length >= 5;
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
          const Text('5-rights check failed',
              style: TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text(
            'To record this administration, document the reason. This entry '
            'is audited.',
            style: TextStyle(fontSize: 12),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _reason,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Override reason (required, min 5 chars)',
              border: OutlineInputBorder(),
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.errorRed,
                foregroundColor: Colors.white,
              ),
              onPressed: (!valid || widget.busy)
                  ? null
                  : () => widget.onOverride(_reason.text.trim()),
              child: Text(widget.busy ? 'Recording…' : 'Override & administer'),
            ),
          ),
        ],
      ),
    );
  }
}
