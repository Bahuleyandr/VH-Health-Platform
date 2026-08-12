import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

typedef ClinicalDeviceLoader = Future<List<Map<String, dynamic>>> Function();
typedef DeviceAssociationLoader =
    Future<List<Map<String, dynamic>>> Function({required String patientUid});
typedef DeviceAssociator =
    Future<Map<String, dynamic>> Function({
      required String patientUid,
      required String deviceCode,
    });
typedef DeviceAssociationDisconnector =
    Future<Map<String, dynamic>> Function(int id);
typedef DeviceAssociationPatientLoader =
    Future<Map<String, dynamic>?> Function(String patientUid);

enum _DeviceAssocStep { scanPatient, scanDevice, review, associated }

class DeviceAssociationScanScreen extends StatefulWidget {
  const DeviceAssociationScanScreen({
    super.key,
    this.initialPatientUid,
    this.patientName,
    this.loadDevices,
    this.loadAssociations,
    this.loadPatientIdentity,
    this.associateDevice,
    this.disconnectAssociation,
  });

  final String? initialPatientUid;
  final String? patientName;
  final ClinicalDeviceLoader? loadDevices;
  final DeviceAssociationLoader? loadAssociations;
  final DeviceAssociationPatientLoader? loadPatientIdentity;
  final DeviceAssociator? associateDevice;
  final DeviceAssociationDisconnector? disconnectAssociation;

  @override
  State<DeviceAssociationScanScreen> createState() =>
      _DeviceAssociationScanScreenState();
}

class _DeviceAssociationScanScreenState
    extends State<DeviceAssociationScanScreen> {
  late _DeviceAssocStep _step;
  String? _patientUid;
  String? _deviceCode;
  bool _busy = false;
  bool _scanLock = false;
  String? _error;
  List<Map<String, dynamic>> _devices = const [];
  List<Map<String, dynamic>> _associations = const [];
  Map<String, dynamic>? _verifiedPatient;
  bool _patientIdentityLoading = false;
  String? _patientIdentityError;
  int _patientIdentityGeneration = 0;

  final MobileScannerController _scannerController = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
  );

  @override
  void initState() {
    super.initState();
    _patientUid = widget.initialPatientUid;
    _step = _patientUid == null
        ? _DeviceAssocStep.scanPatient
        : _DeviceAssocStep.scanDevice;
    _loadDevices();
    if (_patientUid != null) {
      unawaited(_verifyPatientIdentity(_patientUid!));
      _loadAssociations();
    }
  }

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  void _onScan(BarcodeCapture capture) {
    if (_scanLock) return;
    final raw = capture.barcodes.isEmpty
        ? null
        : capture.barcodes.first.rawValue;
    if (raw == null || raw.trim().isEmpty) return;
    _scanLock = true;
    final value = raw.trim();
    setState(() {
      _error = null;
      if (_step == _DeviceAssocStep.scanPatient) {
        _patientUid = value;
        _verifiedPatient = null;
        _patientIdentityError = null;
        _step = _DeviceAssocStep.scanDevice;
        unawaited(_verifyPatientIdentity(value));
        unawaited(_loadAssociations());
      } else if (_step == _DeviceAssocStep.scanDevice) {
        _deviceCode = value;
        _step = _DeviceAssocStep.review;
      }
    });
    Future.delayed(const Duration(milliseconds: 700), () {
      _scanLock = false;
    });
  }

  Future<void> _loadDevices() async {
    try {
      final rows =
          await (widget.loadDevices ?? MedicalApiService.listClinicalDevices)();
      if (mounted) setState(() => _devices = rows);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  String? _boundedIdentityText(dynamic value, int maxLength) {
    final text = value?.toString().trim() ?? '';
    if (text.isEmpty) return null;
    return text.length <= maxLength ? text : text.substring(0, maxLength);
  }

  Future<Map<String, dynamic>?> _loadAuthoritativePatient(
    String patientUid,
  ) async {
    final injected = widget.loadPatientIdentity;
    if (injected != null) return injected(patientUid);
    final matches = await PatientApiService.search(patientUid, limit: 2);
    return matches.cast<Map<String, dynamic>?>().firstWhere(
      (patient) =>
          patient?['uid']?.toString().trim().toLowerCase() ==
          patientUid.trim().toLowerCase(),
      orElse: () => null,
    );
  }

  Future<void> _verifyPatientIdentity(String patientUid) async {
    final generation = ++_patientIdentityGeneration;
    if (mounted) {
      setState(() {
        _patientIdentityLoading = true;
        _patientIdentityError = null;
        _verifiedPatient = null;
      });
    }
    try {
      final patient = await _loadAuthoritativePatient(patientUid);
      final name = _boundedIdentityText(patient?['name'], 160);
      final hospitalNumber = _boundedIdentityText(
        patient?['hospital_number'],
        80,
      );
      final resolvedUid = patient?['uid']?.toString().trim().toLowerCase();
      if (patient == null ||
          resolvedUid != patientUid.trim().toLowerCase() ||
          name == null ||
          hospitalNumber == null) {
        throw StateError('Patient identity could not be verified');
      }
      if (!mounted || generation != _patientIdentityGeneration) return;
      setState(() {
        _verifiedPatient = {
          'uid': resolvedUid,
          'name': name,
          'hospital_number': hospitalNumber,
        };
        _patientIdentityLoading = false;
        _patientIdentityError = null;
      });
    } catch (e) {
      if (!mounted || generation != _patientIdentityGeneration) return;
      setState(() {
        _verifiedPatient = null;
        _patientIdentityLoading = false;
        _patientIdentityError = e
            .toString()
            .replaceFirst('Exception: ', '')
            .replaceFirst('Bad state: ', '');
      });
    }
  }

  Future<void> _loadAssociations() async {
    final patientUid = _patientUid;
    if (patientUid == null) return;
    try {
      final rows = widget.loadAssociations == null
          ? await MedicalApiService.listDeviceAssociations(
              patientUid: patientUid,
            )
          : await widget.loadAssociations!(patientUid: patientUid);
      if (mounted) setState(() => _associations = rows);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _associate() async {
    final patientUid = _patientUid;
    final deviceCode = _deviceCode;
    if (patientUid == null ||
        deviceCode == null ||
        _verifiedPatient?['uid']?.toString().toLowerCase() !=
            patientUid.toLowerCase()) {
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (widget.associateDevice == null) {
        await MedicalApiService.associateDevice(
          patientUid: patientUid,
          deviceCode: deviceCode,
        );
      } else {
        await widget.associateDevice!(
          patientUid: patientUid,
          deviceCode: deviceCode,
        );
      }
      await _loadAssociations();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(AppStrings.of(context).lookup('device_assoc.saved')),
        ),
      );
      setState(() => _step = _DeviceAssocStep.associated);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _disconnect(int id) async {
    setState(() => _busy = true);
    try {
      if (widget.disconnectAssociation == null) {
        await MedicalApiService.disconnectDeviceAssociation(id);
      } else {
        await widget.disconnectAssociation!(id);
      }
      await _loadAssociations();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            AppStrings.of(context).lookup('device_assoc.disconnected'),
          ),
        ),
      );
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.lookup('device_assoc.title'),
      body: Column(
        children: [
          if (_step == _DeviceAssocStep.scanPatient ||
              _step == _DeviceAssocStep.scanDevice)
            Expanded(
              flex: 3,
              child: MobileScanner(
                controller: _scannerController,
                onDetect: _onScan,
              ),
            ),
          Expanded(
            flex: 4,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _StepPanel(step: _step, patientUid: _patientUid),
                const SizedBox(height: 16),
                if (_step == _DeviceAssocStep.scanDevice) _devicePicker(s),
                if (_step == _DeviceAssocStep.review) _reviewPanel(s),
                if (_busy) const LinearProgressIndicator(),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: const TextStyle(color: Colors.red)),
                ],
                const SizedBox(height: 16),
                _associationList(s),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _devicePicker(AppStrings s) {
    final selectedCode =
        _devices.any(
          (device) => device['device_code']?.toString() == _deviceCode,
        )
        ? _deviceCode
        : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DropdownButtonFormField<String>(
          initialValue: selectedCode,
          items: _devices.map((device) {
            final code = device['device_code']?.toString() ?? '';
            final name = device['display_name']?.toString() ?? code;
            return DropdownMenuItem(value: code, child: Text('$name - $code'));
          }).toList(),
          onChanged: (value) => setState(() => _deviceCode = value),
          decoration: InputDecoration(
            labelText: s.lookup('device_assoc.pick_device'),
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: selectedCode == null || selectedCode.isEmpty || _busy
              ? null
              : () => setState(() => _step = _DeviceAssocStep.review),
          icon: const Icon(Icons.link),
          label: const AppText('device_assoc.title'),
        ),
      ],
    );
  }

  Widget _reviewPanel(AppStrings s) {
    final device = _devices.cast<Map<String, dynamic>?>().firstWhere(
      (row) => row?['device_code']?.toString() == _deviceCode,
      orElse: () => null,
    );
    final deviceLabel = device?['display_name']?.toString().trim();
    final code = _deviceCode ?? '';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              s.lookup('device_assoc.review'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (_patientIdentityLoading)
              Row(
                children: [
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 8),
                  Text(s.labelLoading),
                ],
              )
            else if (_verifiedPatient != null) ...[
              Text(
                _verifiedPatient!['name'].toString(),
                style: Theme.of(context).textTheme.titleSmall,
              ),
              Text(
                s.format('s4.dynamic.bed_board.semantic.hospital_id', {
                  'id': _verifiedPatient!['hospital_number'],
                }),
              ),
            ] else ...[
              Text(
                _patientIdentityError ??
                    s.lookup(
                      's4.lib.appointments.could_not_check_registry_new_patient_available',
                    ),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: _patientUid == null
                      ? null
                      : () => _verifyPatientIdentity(_patientUid!),
                  child: Text(s.actionRetry),
                ),
              ),
            ],
            Text(
              deviceLabel == null || deviceLabel.isEmpty
                  ? code
                  : '$deviceLabel - $code',
            ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => setState(() {
                          _deviceCode = null;
                          _step = _DeviceAssocStep.scanDevice;
                        }),
                  child: Text(s.actionCancel),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed:
                      _busy ||
                          _patientIdentityLoading ||
                          _verifiedPatient == null
                      ? null
                      : _associate,
                  child: Text(s.actionConfirm),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _associationList(AppStrings s) {
    if (_associations.isEmpty) {
      return const ListTile(
        leading: Icon(Icons.sensors_off),
        title: AppText('device_assoc.none_active'),
      );
    }
    return Column(
      children: _associations.map((association) {
        final id = int.tryParse('${association['id']}') ?? 0;
        return Card(
          child: ListTile(
            leading: const Icon(Icons.sensors),
            title: Text(
              association['device_name']?.toString() ??
                  association['device_code']?.toString() ??
                  '',
            ),
            subtitle: Text(association['channel']?.toString() ?? ''),
            trailing: IconButton(
              tooltip: s.lookup('device_assoc.disconnect'),
              onPressed: id > 0 && !_busy ? () => _disconnect(id) : null,
              icon: const Icon(Icons.link_off),
            ),
          ),
        );
      }).toList(),
    );
  }
}

class _StepPanel extends StatelessWidget {
  const _StepPanel({required this.step, required this.patientUid});

  final _DeviceAssocStep step;
  final String? patientUid;

  @override
  Widget build(BuildContext context) {
    final key = switch (step) {
      _DeviceAssocStep.scanPatient => 'device_assoc.scan_patient',
      _DeviceAssocStep.scanDevice => 'device_assoc.scan_device',
      _DeviceAssocStep.review => 'device_assoc.review',
      _DeviceAssocStep.associated => 'device_assoc.saved',
    };
    return Card(
      child: ListTile(
        leading: const Icon(Icons.qr_code_scanner),
        title: AppText(key),
        subtitle: patientUid == null ? null : Text(patientUid!),
      ),
    );
  }
}
