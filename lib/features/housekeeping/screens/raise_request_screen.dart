import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'dart:io';
import '../../../core/services/staff_api_service.dart';

class RaiseRequestScreen extends StatefulWidget {
  const RaiseRequestScreen({super.key});

  @override
  State<RaiseRequestScreen> createState() => _RaiseRequestScreenState();
}

class _RaiseRequestScreenState extends State<RaiseRequestScreen> {
  List<dynamic> _zones = [];
  int? _selectedZoneId;
  final _locationCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  String _requestType = 'cleaning';
  String _urgency = 'normal';
  File? _photo;
  bool _loading = false;
  bool _submitting = false;
  bool _submitted = false;
  String? _requestNumber;

  static const _requestTypes = {
    'cleaning': 'General Cleaning',
    'spillage': 'Spillage / Spill',
    'waste': 'Waste Disposal',
    'linen': 'Linen / Bedding',
    'disinfection': 'Disinfection',
    'other': 'Other',
  };

  static const _urgencyConfig = {
    'low': (label: 'Low', color: Color(0xFF4CAF50)),
    'normal': (label: 'Normal', color: Color(0xFF607D8B)),
    'high': (label: 'High', color: Color(0xFFF57C00)),
    'urgent': (label: 'Urgent', color: Color(0xFFD32F2F)),
  };

  @override
  void initState() {
    super.initState();
    _loadZones();
  }

  @override
  void dispose() {
    _locationCtrl.dispose();
    _descCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadZones() async {
    setState(() => _loading = true);
    try {
      final zones = await StaffApiService.getHousekeepingZones();
      if (mounted) setState(() => _zones = zones);
    } catch (e) {
      debugPrint('raise_request_screen.dart: $e'); // non-fatal
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickPhoto() async {
    final picker = ImagePicker();
    final image =
        await picker.pickImage(source: ImageSource.camera, imageQuality: 70);
    if (image != null) setState(() => _photo = File(image.path));
  }

  Future<void> _submit() async {
    final location = _locationCtrl.text.trim();
    if (_selectedZoneId == null && location.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Select a zone or enter location'),
          backgroundColor: Colors.red));
      return;
    }
    setState(() => _submitting = true);
    try {
      String? zoneName;
      if (_selectedZoneId != null) {
        final zone =
            _zones.firstWhere((z) => (z as Map)['id'] == _selectedZoneId)
                as Map;
        zoneName = zone['name'] as String?;
      }
      final result = await StaffApiService.raiseHousekeepingRequest(
        locationText: location.isNotEmpty ? location : zoneName ?? '',
        requestType: _requestType,
        urgency: _urgency,
        zoneId: _selectedZoneId,
        description: _descCtrl.text.trim().isNotEmpty
            ? _descCtrl.text.trim()
            : null,
      );
      final data = result['data'] as Map<String, dynamic>? ?? result;
      if (mounted) {
        setState(() {
          _submitted = true;
          _requestNumber = data['request_number'] as String?;
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content:
                Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: Colors.red));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_submitted) {
      return Scaffold(
        backgroundColor: const Color(0xFFE0F5F6),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: 80,
                  height: 80,
                  decoration: const BoxDecoration(
                      color: Colors.orange, shape: BoxShape.circle),
                  child:
                      const Icon(Icons.check, color: Colors.white, size: 44),
                ),
                const SizedBox(height: 20),
                const Text('Request Raised',
                    style: TextStyle(
                        fontSize: 22, fontWeight: FontWeight.bold)),
                if (_requestNumber != null) ...[
                  const SizedBox(height: 8),
                  Text(_requestNumber!,
                      style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                          color: Colors.orange,
                          letterSpacing: 1)),
                ],
                const SizedBox(height: 12),
                Text('Housekeeping staff will be notified.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey.shade600)),
                const SizedBox(height: 32),
                ElevatedButton(
                  onPressed: () => Navigator.pop(context),
                  style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.orange,
                      minimumSize: const Size(200, 46),
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10))),
                  child: const Text('Done',
                      style: TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.bold)),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
          title: const Text('Raise Request'),
          backgroundColor: Colors.orange,
          foregroundColor: Colors.white),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Request type
            const Text('Request Type *',
                style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _requestType,
              decoration:
                  const InputDecoration(border: OutlineInputBorder()),
              items: _requestTypes.entries
                  .map((e) =>
                      DropdownMenuItem(value: e.key, child: Text(e.value)))
                  .toList(),
              onChanged: (v) => setState(() => _requestType = v!),
            ),
            const SizedBox(height: 16),

            // Urgency
            const Text('Urgency *',
                style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Row(
              children: _urgencyConfig.entries.map((e) {
                final selected = _urgency == e.key;
                return Expanded(
                  child: GestureDetector(
                    onTap: () => setState(() => _urgency = e.key),
                    child: Container(
                      margin: const EdgeInsets.symmetric(horizontal: 3),
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      decoration: BoxDecoration(
                        color: selected
                            ? e.value.color
                            : e.value.color.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: e.value.color),
                      ),
                      child: Text(
                        e.value.label,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          color: selected ? Colors.white : e.value.color,
                        ),
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 16),

            // Zone / Location
            const Text('Zone / Location *',
                style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else ...[
              DropdownButtonFormField<int?>(
                initialValue: _selectedZoneId,
                decoration: const InputDecoration(
                    labelText: 'Select Zone (optional)',
                    border: OutlineInputBorder()),
                items: [
                  const DropdownMenuItem<int?>(
                      value: null,
                      child: Text('-- Select or type below --')),
                  ..._zones.map((z) {
                    final zone = z as Map<String, dynamic>;
                    return DropdownMenuItem<int?>(
                      value: zone['id'] as int,
                      child: Text(
                          '${zone['name']} (${zone['zone_type']})'),
                    );
                  }),
                ],
                onChanged: (v) => setState(() => _selectedZoneId = v),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _locationCtrl,
                decoration: const InputDecoration(
                  labelText: 'Or describe exact location *',
                  hintText: 'e.g. Room 204, near door',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
            const SizedBox(height: 16),

            // Description
            TextField(
              controller: _descCtrl,
              decoration: const InputDecoration(
                  labelText: 'Description (optional)',
                  hintText: 'What needs attention?',
                  border: OutlineInputBorder()),
              maxLines: 3,
            ),
            const SizedBox(height: 16),

            // Photo of problem
            const Text('Photo of Problem (optional)',
                style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            InkWell(
              onTap: _pickPhoto,
              child: Container(
                width: double.infinity,
                height: _photo != null ? 200 : 100,
                decoration: BoxDecoration(
                  border: Border.all(
                      color: Colors.grey.shade400,
                      style: BorderStyle.solid),
                  borderRadius: BorderRadius.circular(10),
                  color: Colors.grey.shade50,
                ),
                child: _photo != null
                    ? Stack(children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.file(_photo!,
                              width: double.infinity,
                              height: 200,
                              fit: BoxFit.cover),
                        ),
                        Positioned(
                          top: 8,
                          right: 8,
                          child: GestureDetector(
                            onTap: () => setState(() => _photo = null),
                            child: Container(
                              padding: const EdgeInsets.all(4),
                              decoration: const BoxDecoration(
                                  color: Colors.red,
                                  shape: BoxShape.circle),
                              child: const Icon(Icons.close,
                                  color: Colors.white, size: 16),
                            ),
                          ),
                        ),
                      ])
                    : Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.add_a_photo_outlined,
                              size: 32, color: Colors.grey.shade500),
                          const SizedBox(height: 6),
                          Text('Tap to photograph the problem',
                              style: TextStyle(
                                  color: Colors.grey.shade600,
                                  fontSize: 13)),
                        ],
                      ),
              ),
            ),
            const SizedBox(height: 24),

            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton.icon(
                onPressed: _submitting ? null : _submit,
                style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.orange,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12))),
                icon: _submitting
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                            color: Colors.white, strokeWidth: 2))
                    : const Icon(Icons.send_outlined, color: Colors.white),
                label: Text(
                    _submitting ? 'Raising...' : 'Raise Request',
                    style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: Colors.white)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
