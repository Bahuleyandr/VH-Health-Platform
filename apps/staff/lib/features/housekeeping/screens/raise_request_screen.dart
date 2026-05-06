import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'dart:io';
import '../../../core/services/hr_api_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../l10n/app_strings.dart';

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

  Map<String, String> _requestTypesFor(AppStrings s) => {
    'cleaning': s.housekeepingRequestTypeCleaning,
    'spillage': s.housekeepingRequestTypeSpillage,
    'waste': s.housekeepingRequestTypeWaste,
    'linen': s.housekeepingRequestTypeLinen,
    'disinfection': s.housekeepingRequestTypeDisinfection,
    'other': s.housekeepingRequestTypeOther,
  };

  Map<String, ({String label, Color color})> _urgencyConfigFor(AppStrings s) =>
      {
        'low': (label: s.urgencyLow, color: const Color(0xFF4CAF50)),
        'normal': (label: s.urgencyNormal, color: const Color(0xFF607D8B)),
        'high': (label: s.urgencyHigh, color: const Color(0xFFF57C00)),
        'urgent': (label: s.priorityUrgent, color: const Color(0xFFD32F2F)),
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
      final zones = await HrApiService.getHousekeepingZones();
      if (mounted) setState(() => _zones = zones);
    } catch (e) {
      debugPrint('raise_request_screen.dart: $e'); // non-fatal
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pickPhoto() async {
    final picker = ImagePicker();
    final image = await picker.pickImage(
      source: ImageSource.camera,
      imageQuality: 70,
    );
    if (image != null) setState(() => _photo = File(image.path));
  }

  Future<void> _submit() async {
    final s = AppStrings.of(context);
    final location = _locationCtrl.text.trim();
    if (_selectedZoneId == null && location.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(s.housekeepingSelectZoneError),
          backgroundColor: Colors.red,
        ),
      );
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
      final result = await HrApiService.raiseHousekeepingRequest(
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
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
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
                    color: Colors.orange,
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.check, color: Colors.white, size: 44),
                ),
                const SizedBox(height: 20),
                Text(
                  s.housekeepingRaisedTitle,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                if (_requestNumber != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _requestNumber!,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: Colors.orange,
                      letterSpacing: 1,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                Text(
                  s.housekeepingNotifiedNote,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey.shade600),
                ),
                const SizedBox(height: 32),
                ElevatedButton(
                  onPressed: () => Navigator.pop(context),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.orange,
                    minimumSize: const Size(200, 46),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  child: Text(
                    s.housekeepingDoneButton,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.housekeepingRaiseTitle),
        actions: const [LogoutAction()],
        backgroundColor: Colors.orange,
        foregroundColor: Colors.white,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Request type
            Text(
              s.housekeepingRaiseTypeLabel,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _requestType,
              decoration: const InputDecoration(border: OutlineInputBorder()),
              items: _requestTypesFor(s).entries
                  .map(
                    (e) => DropdownMenuItem(value: e.key, child: Text(e.value)),
                  )
                  .toList(),
              onChanged: (v) => setState(() => _requestType = v!),
            ),
            const SizedBox(height: 16),

            // Urgency
            Text(
              s.housekeepingRaiseUrgencyLabel,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            Row(
              children: _urgencyConfigFor(s).entries.map((e) {
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
            Text(
              s.housekeepingZoneLocationLabel,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else ...[
              DropdownButtonFormField<int?>(
                initialValue: _selectedZoneId,
                decoration: InputDecoration(
                  labelText: s.housekeepingSelectZoneLabel,
                  border: const OutlineInputBorder(),
                ),
                items: [
                  DropdownMenuItem<int?>(
                    value: null,
                    child: Text(s.housekeepingSelectZoneOrType),
                  ),
                  ..._zones.map((z) {
                    final zone = z as Map<String, dynamic>;
                    return DropdownMenuItem<int?>(
                      value: zone['id'] as int,
                      child: Text('${zone['name']} (${zone['zone_type']})'),
                    );
                  }),
                ],
                onChanged: (v) => setState(() => _selectedZoneId = v),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _locationCtrl,
                decoration: InputDecoration(
                  labelText: s.housekeepingDescribeLocation,
                  hintText: s.housekeepingLocationHint,
                  border: const OutlineInputBorder(),
                ),
              ),
            ],
            const SizedBox(height: 16),

            // Description
            TextField(
              controller: _descCtrl,
              decoration: InputDecoration(
                labelText: s.housekeepingDescriptionLabel,
                hintText: s.housekeepingDescriptionHint,
                border: const OutlineInputBorder(),
              ),
              maxLines: 3,
            ),
            const SizedBox(height: 16),

            // Photo of problem
            Text(
              s.housekeepingProblemPhoto,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            InkWell(
              onTap: _pickPhoto,
              child: Container(
                width: double.infinity,
                height: _photo != null ? 200 : 100,
                decoration: BoxDecoration(
                  border: Border.all(
                    color: Colors.grey.shade400,
                    style: BorderStyle.solid,
                  ),
                  borderRadius: BorderRadius.circular(10),
                  color: Colors.grey.shade50,
                ),
                child: _photo != null
                    ? Stack(
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(10),
                            child: Image.file(
                              _photo!,
                              width: double.infinity,
                              height: 200,
                              fit: BoxFit.cover,
                            ),
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
                                  shape: BoxShape.circle,
                                ),
                                child: const Icon(
                                  Icons.close,
                                  color: Colors.white,
                                  size: 16,
                                ),
                              ),
                            ),
                          ),
                        ],
                      )
                    : Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            Icons.add_a_photo_outlined,
                            size: 32,
                            color: Colors.grey.shade500,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            s.housekeepingPhotographProblem,
                            style: TextStyle(
                              color: Colors.grey.shade600,
                              fontSize: 13,
                            ),
                          ),
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
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                icon: _submitting
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          color: Colors.white,
                          strokeWidth: 2,
                        ),
                      )
                    : const Icon(Icons.send_outlined, color: Colors.white),
                label: Text(
                  _submitting
                      ? s.housekeepingRaisingButton
                      : s.housekeepingRaiseRequestButton,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
