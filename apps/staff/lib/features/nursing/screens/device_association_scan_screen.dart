import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../core/services/medical_api_service.dart';
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

enum _DeviceAssocStep { scanPatient, scanDevice, review }

class DeviceAssociationScanScreen extends StatefulWidget {
  const DeviceAssociationScanScreen({
    super.key,
    this.initialPatientUid,
    this.patientName,
    this.loadDevices,
    this.loadAssociations,
    this.associateDevice,
    this.disconnectAssociation,
  });

  final String? initialPatientUid;
  final String? patientName;
  final ClinicalDeviceLoader? loadDevices;
  final DeviceAssociationLoader? loadAssociations;
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
    if (_patientUid != null) _loadAssociations();
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
        _step = _DeviceAssocStep.scanDevice;
      } else if (_step == _DeviceAssocStep.scanDevice) {
        _deviceCode = value;
        _associate();
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
    if (patientUid == null || deviceCode == null) return;
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
      setState(() => _step = _DeviceAssocStep.review);
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
          if (_step != _DeviceAssocStep.review)
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
              : _associate,
          icon: const Icon(Icons.link),
          label: const AppText('device_assoc.title'),
        ),
      ],
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
