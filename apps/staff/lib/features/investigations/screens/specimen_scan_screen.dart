import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:vhhealth_core/services/connectivity_sync_service.dart';

import '../../../core/services/api_client.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/offline_clinical_fallback_dialog.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';
import '../specimen_scan_intent.dart';

@visibleForTesting
Future<void> showSpecimenCollectionOfflineFallback(BuildContext context) {
  final s = AppStrings.of(context);
  return showOfflineClinicalFallbackDialog(
    context,
    paperFormSet: s.offlineClinicalFallbackLaboratoryRequisitionForms,
  );
}

class SpecimenScanScreen extends StatefulWidget {
  const SpecimenScanScreen({
    super.key,
    required this.investigationId,
    this.expectedPatientUid,
  });

  final int investigationId;
  final String? expectedPatientUid;

  @override
  State<SpecimenScanScreen> createState() => _SpecimenScanScreenState();
}

enum _SpecimenScanStep { scanWristband, scanTube, collect, done }

class _SpecimenScanScreenState extends State<SpecimenScanScreen> {
  _SpecimenScanStep _step = _SpecimenScanStep.scanWristband;
  final MobileScannerController _scannerController = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  String? _patientUid;
  String? _tubeBarcode;
  String? _errorMessage;
  SpecimenScanIntent? _hardStop;
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
      if (_step == _SpecimenScanStep.scanWristband) {
        _patientUid = raw;
        _step = _SpecimenScanStep.scanTube;
      } else if (_step == _SpecimenScanStep.scanTube) {
        _tubeBarcode = raw;
        _collectSpecimen();
      }
    });
    Future.delayed(const Duration(milliseconds: 600), () => _scanLock = false);
  }

  Future<void> _collectSpecimen() async {
    final s = AppStrings.of(context);
    final patientUid = _patientUid;
    final tubeBarcode = _tubeBarcode;
    if (patientUid == null || tubeBarcode == null) return;

    final intent = buildSpecimenScanIntent(
      investigationId: widget.investigationId,
      scannedPatientUid: patientUid,
      tubeBarcode: tubeBarcode,
      expectedPatientUid: widget.expectedPatientUid,
    );

    setState(() {
      _step = _SpecimenScanStep.collect;
      _hardStop = intent.hardStop ? intent : null;
      _busy = intent.submit;
      _errorMessage = intent.submit || intent.hardStop
          ? null
          : s.lookup('s4.lib.specimen_scan.scan_both_before_collection');
    });

    if (!intent.submit) return;

    try {
      if (!ConnectivitySyncService.instance.isOnline) {
        await showSpecimenCollectionOfflineFallback(context);
        if (!mounted) return;
        setState(
          () => _errorMessage = s.offlineClinicalFallbackMessage(
            s.offlineClinicalFallbackLaboratoryRequisitionForms,
          ),
        );
        return;
      }
      final response = await ApiClient.post(
        '/lab/samples/${widget.investigationId}/collect',
        body: intent.body,
      );
      if (!mounted) return;
      if (response.isSuccess) {
        setState(() => _step = _SpecimenScanStep.done);
      } else {
        setState(
          () => _errorMessage = response.failureMessage(
            s.lookup('s4.lib.specimen_scan.sample_collection_failed'),
          ),
        );
      }
    } catch (_) {
      if (!mounted) return;
      setState(
        () => _errorMessage = s.lookup('s4.lib.scan_common.server_unreachable'),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _reset() {
    setState(() {
      _step = _SpecimenScanStep.scanWristband;
      _patientUid = null;
      _tubeBarcode = null;
      _hardStop = null;
      _errorMessage = null;
      _busy = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.lookup('s4.lib.specimen_scan.title'),
      body: _buildBody(s),
    );
  }

  Widget _buildBody(AppStrings s) {
    switch (_step) {
      case _SpecimenScanStep.scanWristband:
        return _scanPanel(
          icon: Icons.badge_outlined,
          title: s.lookup('s4.lib.scan_common.scan_patient_wristband'),
          subtitle: s.lookup('s4.lib.specimen_scan.patient_wristband_subtitle'),
        );
      case _SpecimenScanStep.scanTube:
        return _scanPanel(
          icon: Icons.science_outlined,
          title: s.lookup('s4.lib.specimen_scan.scan_sample_tube'),
          subtitle: s.lookup('s4.lib.specimen_scan.scan_sample_tube_subtitle'),
        );
      case _SpecimenScanStep.collect:
        return _collectPanel(s);
      case _SpecimenScanStep.done:
        return _donePanel(s);
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
              Icon(icon, color: AppTheme.primaryBlue),
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

  Widget _collectPanel(AppStrings s) {
    if (_busy) return const Center(child: CircularProgressIndicator());
    final hardStop = _hardStop;
    if (hardStop != null) return _hardStopPanel(hardStop);

    return _messagePanel(
      icon: Icons.error_outline,
      color: AppTheme.errorRed,
      title: s.lookup('s4.lib.specimen_scan.specimen_not_collected'),
      message:
          _errorMessage ?? s.lookup('s4.lib.scan_common.please_scan_again'),
      actionLabel: s.marScanScanAgain,
      onAction: _reset,
    );
  }

  Widget _hardStopPanel(SpecimenScanIntent intent) {
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
                  child: AppText(
                    's4.lib.specimen_scan.specimen_hard_stop',
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
            const Row(
              children: [
                Icon(Icons.cancel, color: AppTheme.errorRed, size: 18),
                SizedBox(width: 8),
                Expanded(
                  child: AppText(
                    's4.lib.specimen_scan.patient_wristband_mismatch',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            AppText(
              's4.lib.specimen_scan.this_cannot_be_overridden_re_scan_the_correct_wr',
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
                label: const AppText('mar_scan.scan_again'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _donePanel(AppStrings s) {
    return _messagePanel(
      icon: Icons.check_circle,
      color: AppTheme.successGreen,
      title: s.lookup('s4.lib.specimen_scan.specimen_collected'),
      message: s.lookup('s4.lib.specimen_scan.specimen_collected_message'),
      actionLabel: s.incidentReportDoneButton,
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
