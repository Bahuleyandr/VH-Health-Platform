// Book-investigation wizard. This screen owns the form state and business
// logic (catalog fetch, slip-photo capture, multipart submit); each of the
// three Stepper steps + the success view render from features/
// investigations/widgets/.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/core/utils/input_sanitizer.dart';
import 'package:vhhealth/features/investigations/widgets/booking_success_view.dart';
import 'package:vhhealth/features/investigations/widgets/book_investigation_step_choose.dart';
import 'package:vhhealth/features/investigations/widgets/book_investigation_step_collection.dart';
import 'package:vhhealth/features/investigations/widgets/book_investigation_step_review.dart';

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
  String? _catalogError;
  String _searchQuery = '';
  Timer? _searchDebounce;
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
  bool _didLoadCatalog = false;

  static const _timeSlots = ['09:00-12:00', '12:00-15:00', '15:00-18:00'];
  MediaType? _contentTypeForUpload(String path, String? fileName) {
    final name = (fileName?.isNotEmpty == true ? fileName! : path)
        .toLowerCase();
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
      return MediaType('image', 'jpeg');
    }
    if (name.endsWith('.png')) return MediaType('image', 'png');
    if (name.endsWith('.pdf')) return MediaType('application', 'pdf');
    return null;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_didLoadCatalog) return;
    _didLoadCatalog = true;
    _fetchCatalog();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    _customTestController.dispose();
    _addressController.dispose();
    _landmarkController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _fetchCatalog() async {
    final l = AppLocalizations.of(context)!;
    setState(() {
      _loadingCatalog = true;
      _catalogError = null;
    });
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
        setState(() {
          _catalogError =
              response.message ?? l.bookInvestigationCatalogLoadFailed;
          _loadingCatalog = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _catalogError = l.bookInvestigationCatalogLoadFailed;
        _loadingCatalog = false;
      });
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
        fields['custom_test_names'] = InputSanitizer.sanitize(
          _customTestController.text.trim(),
        );
      }
      fields['collection_type'] = _collectionType;
      if (_collectionType == 'home') {
        if (_addressController.text.trim().isNotEmpty) {
          fields['collection_address'] = InputSanitizer.sanitize(
            _addressController.text.trim(),
          );
        }
        if (_landmarkController.text.trim().isNotEmpty) {
          fields['collection_landmark'] = InputSanitizer.sanitize(
            _landmarkController.text.trim(),
          );
        }
      }
      if (_preferredDate != null) {
        fields['preferred_date'] = DateFormat(
          'yyyy-MM-dd',
        ).format(_preferredDate!);
      }
      if (_preferredTimeSlot != null) {
        fields['preferred_time_slot'] = _preferredTimeSlot!;
      }
      if (_notesController.text.trim().isNotEmpty) {
        fields['notes'] = InputSanitizer.sanitize(_notesController.text.trim());
      }

      // Attach slip photo
      final files = <http.MultipartFile>[];
      if (_slipPhoto != null) {
        files.add(
          await http.MultipartFile.fromPath(
            'slip_photo',
            _slipPhoto!.path,
            filename: _slipPhotoName ?? 'slip.jpg',
            contentType: _contentTypeForUpload(
              _slipPhoto!.path,
              _slipPhotoName,
            ),
          ),
        );
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
        _showError(
          response.message ??
              AppLocalizations.of(context)!.bookInvestigationBookingFailed,
        );
      }
    } catch (e) {
      _showError(AppLocalizations.of(context)!.bookInvestigationBookingError);
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: Colors.red.shade700,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  bool get _canProceedStep1 {
    return _selectedTestIds.isNotEmpty ||
        _customTestController.text.trim().isNotEmpty ||
        _slipPhoto != null;
  }

  bool get _canProceedStep2 {
    if (_collectionType == 'home' && _addressController.text.trim().isEmpty) {
      return false;
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final timeSlotLabels = [
      l.bookInvestigationSlotMorning,
      l.bookInvestigationSlotAfternoon,
      l.bookInvestigationSlotEvening,
    ];

    return Scaffold(
      appBar: AppBar(title: Text(l.bookInvestigationTitle), elevation: 0),
      body: _bookingResult != null
          ? BookingSuccessView(bookingResult: _bookingResult!)
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
                          onPressed:
                              (_currentStep == 0 && _canProceedStep1) ||
                                  (_currentStep == 1 && _canProceedStep2)
                              ? details.onStepContinue
                              : null,
                          child: Text(l.commonContinueButton),
                        )
                      else
                        FilledButton.icon(
                          onPressed: _isSubmitting
                              ? null
                              : details.onStepContinue,
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
                            _isSubmitting
                                ? l.bookInvestigationBookingButton
                                : l.bookInvestigationBookNowButton,
                          ),
                        ),
                      const SizedBox(width: 12),
                      if (_currentStep > 0)
                        TextButton(
                          onPressed: details.onStepCancel,
                          child: Text(l.commonBackButton),
                        ),
                    ],
                  ),
                );
              },
              steps: [
                Step(
                  title: Text(l.bookInvestigationStepChoose),
                  subtitle: _selectedTestIds.isNotEmpty
                      ? Text(
                          l.bookInvestigationSelectedCount(
                            _selectedTestIds.length,
                          ),
                        )
                      : null,
                  isActive: _currentStep >= 0,
                  state: _currentStep > 0
                      ? StepState.complete
                      : StepState.indexed,
                  content: BookInvestigationStepChoose(
                    loadingCatalog: _loadingCatalog,
                    catalogError: _catalogError,
                    groupedCatalog: _groupedCatalog,
                    selectedTestIds: _selectedTestIds,
                    customTestController: _customTestController,
                    slipPhoto: _slipPhoto,
                    slipPhotoName: _slipPhotoName,
                    estimatedCost: _estimatedCost,
                    onSearchChanged: (v) {
                      _searchDebounce?.cancel();
                      _searchDebounce = Timer(
                        const Duration(milliseconds: 300),
                        () {
                          if (mounted) setState(() => _searchQuery = v);
                        },
                      );
                    },
                    onCatalogRetry: _fetchCatalog,
                    onTestToggle: (id, selected) {
                      setState(() {
                        if (selected == true) {
                          _selectedTestIds.add(id);
                        } else {
                          _selectedTestIds.remove(id);
                        }
                      });
                    },
                    onCustomTestChanged: () => setState(() {}),
                    onPickCamera: _pickSlipPhoto,
                    onPickGallery: _pickSlipFromGallery,
                    onRemoveSlip: () => setState(() {
                      _slipPhoto = null;
                      _slipPhotoName = null;
                    }),
                  ),
                ),
                Step(
                  title: Text(l.bookInvestigationStepCollection),
                  subtitle: Text(
                    _collectionType == 'home'
                        ? l.bookInvestigationHomeCollection
                        : l.bookInvestigationVisitLab,
                  ),
                  isActive: _currentStep >= 1,
                  state: _currentStep > 1
                      ? StepState.complete
                      : StepState.indexed,
                  content: BookInvestigationStepCollection(
                    collectionType: _collectionType,
                    addressController: _addressController,
                    landmarkController: _landmarkController,
                    notesController: _notesController,
                    preferredDate: _preferredDate,
                    preferredTimeSlot: _preferredTimeSlot,
                    timeSlots: _timeSlots,
                    timeSlotLabels: timeSlotLabels,
                    onCollectionTypeChanged: (v) =>
                        setState(() => _collectionType = v),
                    onAddressChanged: () => setState(() {}),
                    onDatePicked: (d) => setState(() => _preferredDate = d),
                    onTimeSlotChanged: (s) =>
                        setState(() => _preferredTimeSlot = s),
                  ),
                ),
                Step(
                  title: Text(l.bookInvestigationStepReview),
                  isActive: _currentStep >= 2,
                  state: StepState.indexed,
                  content: BookInvestigationStepReview(
                    selectedTests: _catalog
                        .where((t) => _selectedTestIds.contains(t['id']))
                        .toList(),
                    customTestNames: _customTestController.text.trim(),
                    hasSlipPhoto: _slipPhoto != null,
                    collectionType: _collectionType,
                    collectionAddress: _addressController.text.trim(),
                    preferredDate: _preferredDate,
                    preferredTimeSlot: _preferredTimeSlot,
                    estimatedCost: _estimatedCost,
                  ),
                ),
              ],
            ),
    );
  }
}
