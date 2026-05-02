import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'dart:io';
import '../../../core/services/hr_api_service.dart';
import '../../../core/widgets/logout_action.dart';

class LogCleaningScreen extends StatefulWidget {
  const LogCleaningScreen({super.key});

  @override
  State<LogCleaningScreen> createState() => _LogCleaningScreenState();
}

class _LogCleaningScreenState extends State<LogCleaningScreen> {
  List<dynamic> _zones = [];
  int? _selectedZoneId;
  String? _selectedZoneName;
  final _locationCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  String _cleaningType = 'routine';
  File? _photo;
  bool _loading = false;
  bool _submitting = false;
  bool _submitted = false;
  String? _logNumber;

  static const _cleaningTypes = {
    'routine': 'Routine Cleaning',
    'deep': 'Deep Cleaning',
    'disinfection': 'Disinfection',
    'spillage': 'Spillage Clean-up',
    'post_procedure': 'Post-Procedure',
  };

  @override
  void initState() {
    super.initState();
    _loadZones();
  }

  @override
  void dispose() {
    _locationCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadZones() async {
    setState(() => _loading = true);
    try {
      final zones = await HrApiService.getHousekeepingZones();
      if (mounted) setState(() => _zones = zones);
    } catch (e) {
      debugPrint('log_cleaning_screen.dart: $e'); // non-fatal
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
    if (_selectedZoneId == null && _locationCtrl.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Select a zone or enter location'),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }
    setState(() => _submitting = true);
    try {
      final result = await HrApiService.submitCleaningLog(
        cleaningType: _cleaningType,
        zoneId: _selectedZoneId,
        locationText: _locationCtrl.text.trim().isNotEmpty
            ? _locationCtrl.text.trim()
            : _selectedZoneName,
        notes: _notesCtrl.text.trim().isNotEmpty
            ? _notesCtrl.text.trim()
            : null,
      );
      final data = result['data'] as Map<String, dynamic>? ?? result;
      if (mounted) {
        setState(() {
          _submitted = true;
          _logNumber = data['log_number'] as String?;
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
                    color: Color(0xFF007A64),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.check, color: Colors.white, size: 44),
                ),
                const SizedBox(height: 20),
                const Text(
                  'Cleaning Logged',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
                ),
                if (_logNumber != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _logNumber!,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF007A64),
                      letterSpacing: 1,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                Text(
                  'Your cleaning record has been signed and submitted.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey.shade600),
                ),
                const SizedBox(height: 32),
                ElevatedButton(
                  onPressed: () => Navigator.pop(context),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF007A64),
                    minimumSize: const Size(200, 46),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                  ),
                  child: const Text(
                    'Done',
                    style: TextStyle(
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
        title: const Text('Log Cleaning'),
        actions: const [LogoutAction()],
        backgroundColor: const Color(0xFF007A64),
        foregroundColor: Colors.white,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Cleaning Type *',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _cleaningType,
              decoration: const InputDecoration(border: OutlineInputBorder()),
              items: _cleaningTypes.entries
                  .map(
                    (e) => DropdownMenuItem(value: e.key, child: Text(e.value)),
                  )
                  .toList(),
              onChanged: (v) => setState(() => _cleaningType = v!),
            ),
            const SizedBox(height: 16),
            const Text(
              'Zone / Location *',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            if (_loading)
              const Center(child: CircularProgressIndicator())
            else ...[
              DropdownButtonFormField<int?>(
                initialValue: _selectedZoneId,
                decoration: const InputDecoration(
                  labelText: 'Select Zone (optional)',
                  border: OutlineInputBorder(),
                ),
                items: [
                  const DropdownMenuItem<int?>(
                    value: null,
                    child: Text('-- Select or type below --'),
                  ),
                  ..._zones.map((z) {
                    final zone = z as Map<String, dynamic>;
                    return DropdownMenuItem<int?>(
                      value: zone['id'] as int,
                      child: Text('${zone['name']} (${zone['zone_type']})'),
                    );
                  }),
                ],
                onChanged: (v) {
                  setState(() {
                    _selectedZoneId = v;
                    if (v != null) {
                      final zone =
                          _zones.firstWhere((z) => (z as Map)['id'] == v)
                              as Map;
                      _selectedZoneName = zone['name'] as String?;
                    }
                  });
                },
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _locationCtrl,
                decoration: const InputDecoration(
                  labelText: 'Or describe exact location',
                  hintText: 'e.g. Room 204, Corridor near lift',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
            const SizedBox(height: 16),
            const Text(
              'Photo Evidence',
              style: TextStyle(fontWeight: FontWeight.w600),
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
                            Icons.camera_alt_outlined,
                            size: 32,
                            color: Colors.grey.shade500,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'Tap to take photo',
                            style: TextStyle(
                              color: Colors.grey.shade600,
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _notesCtrl,
              decoration: const InputDecoration(
                labelText: 'Notes (optional)',
                border: OutlineInputBorder(),
              ),
              maxLines: 3,
            ),
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton.icon(
                onPressed: _submitting ? null : _submit,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF007A64),
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
                    : const Icon(
                        Icons.check_circle_outline,
                        color: Colors.white,
                      ),
                label: Text(
                  _submitting ? 'Submitting...' : 'Submit Cleaning Log',
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
