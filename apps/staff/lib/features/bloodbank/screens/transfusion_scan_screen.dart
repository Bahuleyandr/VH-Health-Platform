import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../core/services/api_client.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../transfusion_scan_intent.dart';

class TransfusionScanScreen extends StatefulWidget {
  const TransfusionScanScreen({
    super.key,
    required this.requestId,
    this.verifierRole = 'first',
    this.expectedPatientUid,
    this.expectedUnitNumber,
  });

  final int requestId;
  final String verifierRole;
  final String? expectedPatientUid;
  final String? expectedUnitNumber;

  @override
  State<TransfusionScanScreen> createState() => _TransfusionScanScreenState();
}

enum _TransfusionScanStep { scanWristband, scanUnit, verify, done }

class _TransfusionScanScreenState extends State<TransfusionScanScreen> {
  _TransfusionScanStep _step = _TransfusionScanStep.scanWristband;
  final MobileScannerController _scannerController = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  String? _patientUid;
  String? _unitNumber;
  String? _errorMessage;
  TransfusionScanIntent? _hardStop;
  bool _busy = false;
  bool _scanLock = false;

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  void _onScan(BarcodeCapture capture) {
    if (_scanLock) return;
    final raw = capture.barcodes.firstOrNull?.rawValue?.trim();
    if (raw == null || raw.isEmpty) return;
    _scanLock = true;
    setState(() {
      _errorMessage = null;
      if (_step == _TransfusionScanStep.scanWristband) {
        _patientUid = raw;
        _step = _TransfusionScanStep.scanUnit;
      } else if (_step == _TransfusionScanStep.scanUnit) {
        _unitNumber = raw;
        _submitVerification();
      }
    });
    Future.delayed(const Duration(milliseconds: 600), () => _scanLock = false);
  }

  Future<void> _submitVerification() async {
    final patientUid = _patientUid;
    final unitNumber = _unitNumber;
    if (patientUid == null || unitNumber == null) return;

    final intent = buildTransfusionScanIntent(
      requestId: widget.requestId,
      verifierRole: widget.verifierRole,
      scannedPatientUid: patientUid,
      scannedUnitNumber: unitNumber,
      expectedPatientUid: widget.expectedPatientUid,
      expectedUnitNumber: widget.expectedUnitNumber,
    );

    setState(() {
      _step = _TransfusionScanStep.verify;
      _hardStop = intent.hardStop ? intent : null;
      _busy = intent.submit;
      _errorMessage = intent.submit || intent.hardStop
          ? null
          : 'Scan both wristband and blood unit before verification.';
    });

    if (!intent.submit) return;

    try {
      final response = await ApiClient.post(intent.endpoint, body: intent.body);
      if (!mounted) return;
      if (response.isSuccess) {
        setState(() => _step = _TransfusionScanStep.done);
      } else {
        setState(
          () => _errorMessage = response.failureMessage(
            'Bedside verification failed.',
          ),
        );
      }
    } catch (_) {
      if (!mounted) return;
      setState(() => _errorMessage = 'Could not reach the server.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _reset() {
    setState(() {
      _step = _TransfusionScanStep.scanWristband;
      _patientUid = null;
      _unitNumber = null;
      _hardStop = null;
      _errorMessage = null;
      _busy = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(title: 'Transfusion scan', body: _buildBody());
  }

  Widget _buildBody() {
    switch (_step) {
      case _TransfusionScanStep.scanWristband:
        return _scanPanel(
          icon: Icons.badge_outlined,
          title: 'Scan patient wristband',
          subtitle: 'Use the wristband attached to this transfusion request.',
        );
      case _TransfusionScanStep.scanUnit:
        return _scanPanel(
          icon: Icons.bloodtype_outlined,
          title: 'Scan blood unit',
          subtitle: 'Scan the unit label before starting transfusion.',
        );
      case _TransfusionScanStep.verify:
        return _verifyPanel();
      case _TransfusionScanStep.done:
        return _donePanel();
    }
  }

  Widget _scanPanel({
    required IconData icon,
    required String title,
    required String subtitle,
  }) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: AppTheme.errorRed),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      subtitle,
                      style: TextStyle(color: AppTheme.textSecondary),
                    ),
                  ],
                ),
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

  Widget _verifyPanel() {
    if (_busy) return const Center(child: CircularProgressIndicator());
    final hardStop = _hardStop;
    if (hardStop != null) return _hardStopPanel(hardStop);

    return _messagePanel(
      icon: Icons.error_outline,
      color: AppTheme.errorRed,
      title: 'Verification not recorded',
      message: _errorMessage ?? 'Please scan again.',
      actionLabel: 'Scan again',
      onAction: _reset,
    );
  }

  Widget _hardStopPanel(TransfusionScanIntent intent) {
    final reasons = <String>[
      if (intent.failedRights.contains('patient')) 'Patient wristband mismatch',
      if (intent.failedRights.contains('unit')) 'Blood unit barcode mismatch',
    ];
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppTheme.errorRed.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppTheme.errorRed),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.block, color: AppTheme.errorRed),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Transfusion hard-stop',
                    style: TextStyle(
                      color: AppTheme.errorRed,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            for (final reason in reasons)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  children: [
                    const Icon(
                      Icons.cancel,
                      color: AppTheme.errorRed,
                      size: 18,
                    ),
                    const SizedBox(width: 8),
                    Expanded(child: Text(reason)),
                  ],
                ),
              ),
            const SizedBox(height: 8),
            Text(
              'This cannot be overridden. Re-scan the correct wristband and unit.',
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.errorRed,
                  foregroundColor: Colors.white,
                ),
                onPressed: _reset,
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text('Scan again'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _donePanel() {
    return _messagePanel(
      icon: Icons.check_circle,
      color: AppTheme.successGreen,
      title: 'Verification recorded',
      message: 'The bedside transfusion verification was recorded.',
      actionLabel: 'Done',
      onAction: () => context.pop(true),
    );
  }

  Widget _messagePanel({
    required IconData icon,
    required Color color,
    required String title,
    required String message,
    required String actionLabel,
    required VoidCallback onAction,
  }) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: color, size: 64),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 20),
            ElevatedButton(onPressed: onAction, child: Text(actionLabel)),
          ],
        ),
      ),
    );
  }
}
