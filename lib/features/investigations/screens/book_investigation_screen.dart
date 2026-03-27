import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:vhhealth/core/services/api_client.dart';

class BookInvestigationScreen extends StatefulWidget {
  const BookInvestigationScreen({super.key});

  @override
  State<BookInvestigationScreen> createState() =>
      _BookInvestigationScreenState();
}

class _BookInvestigationScreenState extends State<BookInvestigationScreen> {
  int _currentStep = 0;

  // Step 1: Test selection
  List<dynamic> _catalog = [];
  bool _loadingCatalog = true;
  String _searchQuery = '';
  final Set<int> _selectedTestIds = {};
  final _customTestController = TextEditingController();
  File? _slipPhoto;
  String? _slipPhotoName;

  // Step 2: Collection preference
  String _collectionType = 'home';
  final _addressController = TextEditingController();
  final _landmarkController = TextEditingController();
  DateTime? _preferredDate;
  String? _preferredTimeSlot;
  final _notesController = TextEditingController();

  // Step 3: Submission
  bool _isSubmitting = false;
  Map<String, dynamic>? _bookingResult;

  static const _timeSlots = [
    '09:00-12:00',
    '12:00-15:00',
    '15:00-18:00',
  ];
  static const _timeSlotLabels = [
    'Morning (9 AM - 12 PM)',
    'Afternoon (12 PM - 3 PM)',
    'Evening (3 PM - 6 PM)',
  ];

  @override
  void initState() {
    super.initState();
    _fetchCatalog();
  }

  @override
  void dispose() {
    _customTestController.dispose();
    _addressController.dispose();
    _landmarkController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _fetchCatalog() async {
    try {
      final response = await ApiClient.get('/investigations/catalog');
      if (!mounted) return;
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List ? data : [];
        setState(() {
          _catalog = list;
          _loadingCatalog = false;
        });
      } else {
        setState(() => _loadingCatalog = false);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingCatalog = false);
    }
  }

  double get _estimatedCost {
    double total = 0;
    for (final test in _catalog) {
      if (_selectedTestIds.contains(test['id'])) {
        total += double.tryParse('${test['default_cost']}') ?? 0;
        if (_collectionType == 'home') {
          total +=
              double.tryParse('${test['home_collection_surcharge']}') ?? 50;
        }
      }
    }
    return total;
  }

  Map<String, List<dynamic>> get _groupedCatalog {
    final filtered = _searchQuery.isEmpty
        ? _catalog
        : _catalog.where((t) {
            final name = (t['name'] ?? '').toString().toLowerCase();
            final code = (t['code'] ?? '').toString().toLowerCase();
            return name.contains(_searchQuery.toLowerCase()) ||
                code.contains(_searchQuery.toLowerCase());
          }).toList();

    final map = <String, List<dynamic>>{};
    for (final t in filtered) {
      final cat = (t['category'] ?? 'Other').toString();
      map.putIfAbsent(cat, () => []).add(t);
    }
    return map;
  }

  Future<void> _pickSlipPhoto() async {
    final picker = ImagePicker();
    final picked = await picker.pickImage(
      source: ImageSource.camera,
      maxWidth: 1200,
      maxHeight: 1200,
      imageQuality: 80,
    );
    if (picked != null) {
      setState(() {
        _slipPhoto = File(picked.path);
        _slipPhotoName = picked.name;
      });
    }
  }

  Future<void> _pickSlipFromGallery() async {
    final picker = ImagePicker();
    final picked = await picker.pickImage(
      source: ImageSource.gallery,
      maxWidth: 1200,
      maxHeight: 1200,
      imageQuality: 80,
    );
    if (picked != null) {
      setState(() {
        _slipPhoto = File(picked.path);
        _slipPhotoName = picked.name;
      });
    }
  }

  Future<void> _submitBooking() async {
    setState(() => _isSubmitting = true);
    try {
      final fields = <String, String>{};

      // Add fields
      if (_selectedTestIds.isNotEmpty) {
        fields['selected_tests'] = jsonEncode(_selectedTestIds.toList());
      }
      if (_customTestController.text.trim().isNotEmpty) {
        fields['custom_test_names'] = _customTestController.text.trim();
      }
      fields['collection_type'] = _collectionType;
      if (_collectionType == 'home') {
        if (_addressController.text.trim().isNotEmpty) {
          fields['collection_address'] = _addressController.text.trim();
        }
        if (_landmarkController.text.trim().isNotEmpty) {
          fields['collection_landmark'] = _landmarkController.text.trim();
        }
      }
      if (_preferredDate != null) {
        fields['preferred_date'] =
            DateFormat('yyyy-MM-dd').format(_preferredDate!);
      }
      if (_preferredTimeSlot != null) {
        fields['preferred_time_slot'] = _preferredTimeSlot!;
      }
      if (_notesController.text.trim().isNotEmpty) {
        fields['notes'] = _notesController.text.trim();
      }

      // Attach slip photo
      final files = <http.MultipartFile>[];
      if (_slipPhoto != null) {
        files.add(await http.MultipartFile.fromPath(
          'slip_photo',
          _slipPhoto!.path,
          filename: _slipPhotoName ?? 'slip.jpg',
        ));
      }

      final response = await ApiClient.multipart(
        '/investigations/bookings/create',
        fields: fields,
        files: files,
      );
      if (!mounted) return;

      if (response.isSuccess) {
        setState(() {
          _bookingResult = response.dataAsMap();
          _currentStep = 3; // success step
        });
      } else {
        _showError(response.message ?? 'Booking failed');
      }
    } catch (e) {
      _showError('Error: ${e.toString()}');
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: Colors.red.shade700,
      behavior: SnackBarBehavior.floating,
    ));
  }

  bool get _canProceedStep1 {
    return _selectedTestIds.isNotEmpty ||
        _customTestController.text.trim().isNotEmpty ||
        _slipPhoto != null;
  }

  bool get _canProceedStep2 {
    if (_collectionType == 'home' &&
        _addressController.text.trim().isEmpty) {
      return false;
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Book Investigation'),
        elevation: 0,
      ),
      body: _bookingResult != null
          ? _buildSuccessView(theme)
          : Stepper(
              currentStep: _currentStep,
              onStepContinue: () {
                if (_currentStep == 0 && _canProceedStep1) {
                  setState(() => _currentStep = 1);
                } else if (_currentStep == 1 && _canProceedStep2) {
                  setState(() => _currentStep = 2);
                } else if (_currentStep == 2 && !_isSubmitting) {
                  _submitBooking();
                }
              },
              onStepCancel: _currentStep > 0
                  ? () => setState(() => _currentStep--)
                  : null,
              controlsBuilder: (context, details) {
                return Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Row(
                    children: [
                      if (_currentStep < 2)
                        FilledButton(
                          onPressed: (_currentStep == 0 && _canProceedStep1) ||
                                  (_currentStep == 1 && _canProceedStep2)
                              ? details.onStepContinue
                              : null,
                          child: const Text('Continue'),
                        )
                      else
                        FilledButton.icon(
                          onPressed:
                              _isSubmitting ? null : details.onStepContinue,
                          icon: _isSubmitting
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    color: Colors.white,
                                  ),
                                )
                              : const Icon(Icons.check),
                          label: Text(
                              _isSubmitting ? 'Booking...' : 'Book Now'),
                        ),
                      const SizedBox(width: 12),
                      if (_currentStep > 0)
                        TextButton(
                          onPressed: details.onStepCancel,
                          child: const Text('Back'),
                        ),
                    ],
                  ),
                );
              },
              steps: [
                Step(
                  title: const Text('Choose Tests'),
                  subtitle: _selectedTestIds.isNotEmpty
                      ? Text('${_selectedTestIds.length} selected')
                      : null,
                  isActive: _currentStep >= 0,
                  state: _currentStep > 0
                      ? StepState.complete
                      : StepState.indexed,
                  content: _buildStep1(theme),
                ),
                Step(
                  title: const Text('Collection Preference'),
                  subtitle: Text(_collectionType == 'home'
                      ? 'Home Collection'
                      : 'Visit Lab'),
                  isActive: _currentStep >= 1,
                  state: _currentStep > 1
                      ? StepState.complete
                      : StepState.indexed,
                  content: _buildStep2(theme),
                ),
                Step(
                  title: const Text('Review & Book'),
                  isActive: _currentStep >= 2,
                  state: StepState.indexed,
                  content: _buildStep3(theme),
                ),
              ],
            ),
    );
  }

  // ─── Step 1: Choose Tests ───────────────────────────────────────────

  Widget _buildStep1(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Search
        TextField(
          decoration: InputDecoration(
            hintText: 'Search tests...',
            prefixIcon: const Icon(Icons.search),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
            ),
            isDense: true,
          ),
          onChanged: (v) => setState(() => _searchQuery = v),
        ),
        const SizedBox(height: 12),

        // Test catalog
        if (_loadingCatalog)
          const Center(child: CircularProgressIndicator())
        else ...[
          ..._groupedCatalog.entries.map((entry) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    entry.key.toUpperCase(),
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                ...entry.value.map((test) {
                  final id = test['id'] as int;
                  final selected = _selectedTestIds.contains(id);
                  final cost = test['default_cost'] ?? 0;
                  return CheckboxListTile(
                    value: selected,
                    onChanged: (v) {
                      setState(() {
                        if (v == true) {
                          _selectedTestIds.add(id);
                        } else {
                          _selectedTestIds.remove(id);
                        }
                      });
                    },
                    title: Text(test['name'] ?? ''),
                    subtitle: Text(
                      '₹$cost${test['requires_fasting'] == true ? ' • Fasting required' : ''}',
                      style: TextStyle(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                  );
                }),
              ],
            );
          }),
        ],

        const Divider(height: 24),

        // Custom test names
        Text('Or type test names:',
            style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        TextField(
          controller: _customTestController,
          decoration: InputDecoration(
            hintText: 'e.g. CBC, Sugar test, Thyroid',
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
            ),
            isDense: true,
          ),
          maxLines: 2,
          onChanged: (_) => setState(() {}),
        ),

        const Divider(height: 24),

        // Upload prescription slip
        Text('Or upload prescription slip:',
            style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        Row(
          children: [
            OutlinedButton.icon(
              onPressed: _pickSlipPhoto,
              icon: const Icon(Icons.camera_alt),
              label: const Text('Camera'),
            ),
            const SizedBox(width: 8),
            OutlinedButton.icon(
              onPressed: _pickSlipFromGallery,
              icon: const Icon(Icons.photo_library),
              label: const Text('Gallery'),
            ),
          ],
        ),
        if (_slipPhoto != null) ...[
          const SizedBox(height: 8),
          Row(
            children: [
              const Icon(Icons.check_circle, color: Colors.green, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _slipPhotoName ?? 'Photo selected',
                  style: theme.textTheme.bodySmall,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close, size: 18),
                onPressed: () => setState(() {
                  _slipPhoto = null;
                  _slipPhotoName = null;
                }),
              ),
            ],
          ),
        ],

        // Estimated cost
        if (_selectedTestIds.isNotEmpty) ...[
          const Divider(height: 24),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.primaryContainer.withValues(alpha: 0.3),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Estimated Cost',
                    style: theme.textTheme.titleSmall),
                Text(
                  '₹${_estimatedCost.toStringAsFixed(0)}',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  // ─── Step 2: Collection Preference ──────────────────────────────────

  Widget _buildStep2(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Collection type
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(
              value: 'home',
              label: Text('Home Collection'),
              icon: Icon(Icons.home),
            ),
            ButtonSegment(
              value: 'walk_in',
              label: Text('Visit Lab'),
              icon: Icon(Icons.local_hospital),
            ),
          ],
          selected: {_collectionType},
          onSelectionChanged: (v) =>
              setState(() => _collectionType = v.first),
        ),
        const SizedBox(height: 16),

        if (_collectionType == 'home') ...[
          TextField(
            controller: _addressController,
            decoration: InputDecoration(
              labelText: 'Collection Address *',
              hintText: 'Enter your full address',
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              isDense: true,
            ),
            maxLines: 2,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _landmarkController,
            decoration: InputDecoration(
              labelText: 'Landmark',
              hintText: 'Near/opposite...',
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              isDense: true,
            ),
          ),
          const SizedBox(height: 12),
        ],

        // Date picker
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.calendar_today),
          title: Text(_preferredDate != null
              ? DateFormat('EEEE, d MMM yyyy').format(_preferredDate!)
              : 'Preferred Date'),
          subtitle: _preferredDate == null
              ? const Text('Tap to select')
              : null,
          onTap: () async {
            final picked = await showDatePicker(
              context: context,
              initialDate: DateTime.now().add(const Duration(days: 1)),
              firstDate: DateTime.now(),
              lastDate: DateTime.now().add(const Duration(days: 30)),
            );
            if (picked != null) setState(() => _preferredDate = picked);
          },
        ),

        // Time slot
        const SizedBox(height: 8),
        Text('Preferred Time Slot', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: List.generate(_timeSlots.length, (i) {
            final selected = _preferredTimeSlot == _timeSlots[i];
            return ChoiceChip(
              label: Text(_timeSlotLabels[i]),
              selected: selected,
              onSelected: (v) {
                setState(() => _preferredTimeSlot =
                    v ? _timeSlots[i] : null);
              },
            );
          }),
        ),

        const SizedBox(height: 16),
        TextField(
          controller: _notesController,
          decoration: InputDecoration(
            labelText: 'Notes (optional)',
            hintText: 'Any special instructions...',
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
            ),
            isDense: true,
          ),
          maxLines: 2,
        ),
      ],
    );
  }

  // ─── Step 3: Review & Book ──────────────────────────────────────────

  Widget _buildStep3(ThemeData theme) {
    final selectedTests = _catalog
        .where((t) => _selectedTestIds.contains(t['id']))
        .toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Review Your Booking', style: theme.textTheme.titleMedium),
        const SizedBox(height: 12),

        if (selectedTests.isNotEmpty) ...[
          Text('Selected Tests:', style: theme.textTheme.titleSmall),
          ...selectedTests.map((t) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: [
                    const Icon(Icons.check, size: 16, color: Colors.green),
                    const SizedBox(width: 8),
                    Expanded(child: Text(t['name'] ?? '')),
                    Text('₹${t['default_cost'] ?? 0}'),
                  ],
                ),
              )),
          const Divider(height: 16),
        ],

        if (_customTestController.text.trim().isNotEmpty) ...[
          Text('Custom Tests:', style: theme.textTheme.titleSmall),
          Text(_customTestController.text.trim()),
          const Divider(height: 16),
        ],

        if (_slipPhoto != null) ...[
          Row(
            children: [
              const Icon(Icons.photo, size: 16),
              const SizedBox(width: 8),
              Text('Prescription slip attached',
                  style: theme.textTheme.bodyMedium),
            ],
          ),
          const Divider(height: 16),
        ],

        // Collection info
        Row(
          children: [
            Icon(
              _collectionType == 'home' ? Icons.home : Icons.local_hospital,
              size: 18,
            ),
            const SizedBox(width: 8),
            Text(
              _collectionType == 'home' ? 'Home Collection' : 'Walk-in (Visit Lab)',
              style: theme.textTheme.titleSmall,
            ),
          ],
        ),
        if (_collectionType == 'home' &&
            _addressController.text.trim().isNotEmpty) ...[
          const SizedBox(height: 4),
          Text('📍 ${_addressController.text.trim()}',
              style: theme.textTheme.bodySmall),
        ],
        if (_preferredDate != null) ...[
          const SizedBox(height: 4),
          Text(
              '📅 ${DateFormat('d MMM yyyy').format(_preferredDate!)}${_preferredTimeSlot != null ? ' • $_preferredTimeSlot' : ''}',
              style: theme.textTheme.bodySmall),
        ],

        if (_selectedTestIds.isNotEmpty) ...[
          const Divider(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.primaryContainer.withValues(alpha: 0.3),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Estimated Cost',
                    style: theme.textTheme.titleSmall),
                Text(
                  '₹${_estimatedCost.toStringAsFixed(0)}',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  // ─── Success View ───────────────────────────────────────────────────

  Widget _buildSuccessView(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.check_circle,
                size: 80, color: theme.colorScheme.primary),
            const SizedBox(height: 16),
            Text(
              'Investigation Booked!',
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              _bookingResult?['booking_number'] ?? '',
              style: theme.textTheme.titleLarge?.copyWith(
                color: theme.colorScheme.primary,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            if (_bookingResult?['estimated_cost'] != null)
              Text(
                'Estimated Cost: ₹${_bookingResult!['estimated_cost']}',
                style: theme.textTheme.bodyLarge,
              ),
            const SizedBox(height: 16),
            Text(
              'You will receive a confirmation call shortly.\nWe\'ll keep you updated on your booking status.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 32),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Back to Investigations'),
            ),
          ],
        ),
      ),
    );
  }
}
