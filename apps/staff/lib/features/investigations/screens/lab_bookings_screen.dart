import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vhhealth_core/services/realtime_client.dart';

import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

String _digitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

int? _intValue(dynamic value) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '');
}

String? _nonEmptyString(dynamic value) {
  final text = value?.toString().trim();
  return text == null || text.isEmpty ? null : text;
}

typedef LabBookingsLoader = Future<dynamic> Function();
typedef RealtimeEventStreamFactory =
    Stream<RealtimeEvent> Function(String channel);

class LabBookingsScreen extends StatefulWidget {
  final LabBookingsLoader? loadBookings;
  final RealtimeEventStreamFactory? realtimeEvents;

  const LabBookingsScreen({super.key, this.loadBookings, this.realtimeEvents});

  @override
  State<LabBookingsScreen> createState() => _LabBookingsScreenState();
}

class _LabBookingsScreenState extends State<LabBookingsScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  List<dynamic> _bookings = [];
  bool _loading = true;
  String? _error;

  // Collection tracking
  Timer? _locationTimer;
  Timer? _refreshDebounce;
  int? _trackingBookingId;
  bool _sharingLocation = false;
  StreamSubscription<RealtimeEvent>? _labEventSub;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _fetchBookings();
    _attachRealtime();
  }

  @override
  void dispose() {
    _labEventSub?.cancel();
    _refreshDebounce?.cancel();
    _stopLocationSharing(notify: false);
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _attachRealtime() async {
    final injectedEvents = widget.realtimeEvents;
    if (injectedEvents != null) {
      _labEventSub = injectedEvents('staff:lab').listen(_handleRealtimeNudge);
      return;
    }

    final rt = RealtimeClient.instance;
    await rt.connect();
    if (!mounted) return;
    _labEventSub = rt.events('staff:lab').listen(_handleRealtimeNudge);
  }

  void _handleRealtimeNudge(RealtimeEvent _) => _debouncedRefresh();

  void _debouncedRefresh() {
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(const Duration(milliseconds: 400), () {
      if (!mounted) return;
      _fetchBookings(showLoading: false);
    });
  }

  void _startLocationSharing(int bookingId) {
    _stopLocationSharing();
    _trackingBookingId = bookingId;
    _sharingLocation = true;
    if (mounted) setState(() {});

    _sendLocation();
    _locationTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (!_sharingLocation) {
        _stopLocationSharing();
        return;
      }
      _sendLocation();
    });
  }

  void _stopLocationSharing({bool notify = true}) {
    _locationTimer?.cancel();
    _locationTimer = null;
    if (_trackingBookingId != null && _sharingLocation) {
      MedicalApiService.stopDeliveryTracking(
        orderType: 'investigation',
        orderId: _trackingBookingId!,
      ).catchError((_) {});
    }
    _trackingBookingId = null;
    _sharingLocation = false;
    if (notify && mounted) setState(() {});
  }

  Future<void> _sendLocation() async {
    if (_trackingBookingId == null) return;
    try {
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );
      await MedicalApiService.updateDeliveryLocation(
        orderType: 'investigation',
        orderId: _trackingBookingId!,
        lat: pos.latitude,
        lng: pos.longitude,
        accuracy: pos.accuracy,
        speed: pos.speed * 3.6,
        heading: pos.heading,
      );
    } catch (e) {
      debugPrint('lab_bookings_screen.dart: $e');
    }
  }

  Future<void> _fetchBookings({bool showLoading = true}) async {
    if (showLoading) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final result =
          await (widget.loadBookings ??
              MedicalApiService.getInvestigationBookingQueue)();
      final data = (result['data'] ?? result);
      if (!mounted) return;
      setState(() {
        _bookings = data is List ? data : [];
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _showCreateBookingDialog() async {
    final s = AppStrings.of(context);
    final formKey = GlobalKey<FormState>();
    final phoneCtrl = TextEditingController();
    final patientNameCtrl = TextEditingController();
    final testsCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    var collectionType = 'walk_in';
    var preferredDate = DateTime.now();
    var preferredTime = TimeOfDay.fromDateTime(
      DateTime.now().add(const Duration(hours: 1)),
    );
    var submitting = false;
    PlatformFile? pickedSlip;

    final created = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          final dateLabel = DateFormat('yyyy-MM-dd').format(preferredDate);
          final timeLabel =
              '${preferredTime.hour.toString().padLeft(2, '0')}:${preferredTime.minute.toString().padLeft(2, '0')}';

          Future<void> submit() async {
            if (!formKey.currentState!.validate()) return;
            if (testsCtrl.text.trim().isEmpty && pickedSlip?.path == null) {
              ScaffoldMessenger.of(ctx).showSnackBar(
                const SnackBar(
                  content: AppText(
                    's4.lib.lab_bookings.enter_test_names_or_attach_a_prescription',
                  ),
                  backgroundColor: AppTheme.errorRed,
                ),
              );
              return;
            }
            setSheetState(() => submitting = true);
            try {
              await MedicalApiService.createInvestigationBooking(
                patientPhone: phoneCtrl.text.trim(),
                patientName: patientNameCtrl.text.trim(),
                customTestNames: testsCtrl.text.trim(),
                collectionType: collectionType,
                preferredDate: dateLabel,
                preferredTimeSlot: timeLabel,
                notes: notesCtrl.text.trim().isEmpty
                    ? null
                    : notesCtrl.text.trim(),
                slipPath: pickedSlip?.path,
                slipFileName: pickedSlip?.name,
              );
              if (ctx.mounted) Navigator.pop(ctx, true);
            } catch (e) {
              if (!ctx.mounted) return;
              setSheetState(() => submitting = false);
              ScaffoldMessenger.of(ctx).showSnackBar(
                SnackBar(
                  content: Text(e.toString().replaceFirst('Exception: ', '')),
                  backgroundColor: AppTheme.errorRed,
                ),
              );
            }
          }

          return Padding(
            padding: EdgeInsets.only(
              left: 20,
              right: 20,
              top: 20,
              bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
            ),
            child: SingleChildScrollView(
              child: Form(
                key: formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Expanded(
                          child: AppText(
                            's4.lib.lab_bookings.new_lab_booking',
                            style: TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close),
                          tooltip: s.actionCancel,
                          onPressed: submitting
                              ? null
                              : () => Navigator.pop(ctx, false),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: phoneCtrl,
                      keyboardType: TextInputType.phone,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('reception_counter.patient.phone'),
                        prefixIcon: const ExcludeSemantics(
                          child: Icon(Icons.phone_outlined),
                        ),
                      ),
                      validator: (value) => _digitsOnly(value ?? '').length < 10
                          ? 'Enter a valid phone number'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: patientNameCtrl,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('reception_counter.patient.name'),
                        helperText: AppStrings.of(context).lookup(
                          's4.lib.lab_bookings.used_if_this_phone_is_not_registered_yet',
                        ),
                        prefixIcon: const ExcludeSemantics(
                          child: Icon(Icons.person_outline),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: testsCtrl,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('s4.lib.lab_bookings.tests'),
                        hintText: AppStrings.of(
                          context,
                        ).lookup('s4.lib.lab_bookings.cbc_rft_urine_routine'),
                        prefixIcon: const ExcludeSemantics(
                          child: Icon(Icons.science),
                        ),
                      ),
                      minLines: 2,
                      maxLines: 3,
                    ),
                    const SizedBox(height: 12),
                    SegmentedButton<String>(
                      segments: const [
                        ButtonSegment(
                          value: 'walk_in',
                          icon: Icon(Icons.local_hospital_outlined),
                          label: AppText('s4.lib.lab_bookings.visit_lab'),
                        ),
                        ButtonSegment(
                          value: 'home',
                          icon: Icon(Icons.home_outlined),
                          label: AppText('lab_bookings.home_collection'),
                        ),
                      ],
                      selected: {collectionType},
                      onSelectionChanged: submitting
                          ? null
                          : (selection) => setSheetState(
                              () => collectionType = selection.first,
                            ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: submitting
                                ? null
                                : () async {
                                    final picked = await showDatePicker(
                                      context: ctx,
                                      initialDate: preferredDate,
                                      firstDate: DateTime.now(),
                                      lastDate: DateTime.now().add(
                                        const Duration(days: 90),
                                      ),
                                    );
                                    if (picked != null) {
                                      setSheetState(
                                        () => preferredDate = picked,
                                      );
                                    }
                                  },
                            icon: const Icon(Icons.calendar_today_outlined),
                            label: Text(dateLabel),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: submitting
                                ? null
                                : () async {
                                    final picked = await showTimePicker(
                                      context: ctx,
                                      initialTime: preferredTime,
                                    );
                                    if (picked != null) {
                                      setSheetState(
                                        () => preferredTime = picked,
                                      );
                                    }
                                  },
                            icon: const Icon(Icons.schedule_outlined),
                            label: Text(timeLabel),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: submitting
                          ? null
                          : () async {
                              final result = await FilePicker.pickFiles(
                                type: FileType.custom,
                                allowedExtensions: [
                                  'pdf',
                                  'jpg',
                                  'jpeg',
                                  'png',
                                ],
                              );
                              if (result != null) {
                                setSheetState(
                                  () => pickedSlip = result.files.single,
                                );
                              }
                            },
                      icon: const Icon(Icons.attach_file),
                      label: Text(pickedSlip?.name ?? 'Attach prescription'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: notesCtrl,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('appt_queue.notes_optional'),
                        prefixIcon: const ExcludeSemantics(
                          child: Icon(Icons.notes_outlined),
                        ),
                      ),
                      maxLines: 2,
                    ),
                    const SizedBox(height: 18),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton.icon(
                        onPressed: submitting ? null : submit,
                        icon: submitting
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Icon(Icons.add, color: Colors.white),
                        label: Text(submitting ? 'Booking...' : 'Book Lab'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppTheme.primaryBlue,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );

    phoneCtrl.dispose();
    patientNameCtrl.dispose();
    testsCtrl.dispose();
    notesCtrl.dispose();

    if (created == true && mounted) {
      _showSnack('Lab booking created');
      _fetchBookings();
    }
  }

  List<dynamic> get _newBookings =>
      _bookings.where((b) => b['status'] == 'BOOKED').toList();

  List<dynamic> get _activeBookings => _bookings
      .where(
        (b) => [
          'CONFIRMED',
          'DISPATCHED',
          'COLLECTED',
          'PROCESSING',
        ].contains(b['status']),
      )
      .toList();

  List<dynamic> get _completedBookings =>
      _bookings.where((b) => b['status'] == 'RESULT_READY').toList();

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: s.labBookingsTitle,
      body: Column(
        children: [
          Container(
            color: Theme.of(context).colorScheme.surface,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Expanded(
                  child: AppText(
                    's4.lib.lab_bookings.book_and_track_op_ip_lab_requests',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: AppTheme.textSecondary,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: AppStrings.of(context).lookup('action.refresh'),
                  onPressed: _fetchBookings,
                  icon: const Icon(Icons.refresh),
                ),
                const SizedBox(width: 8),
                ElevatedButton.icon(
                  onPressed: _showCreateBookingDialog,
                  icon: const Icon(Icons.add, color: Colors.white),
                  label: const AppText('lab_bookings.tab.new'),
                  // The app theme gives ElevatedButton a full-width
                  // (double.infinity) minimumSize — right for buttons stacked
                  // in a Column, but it forces an infinite width inside this
                  // header Row and crashes layout. Override to size-to-content.
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryBlue,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, 44),
                  ),
                ),
              ],
            ),
          ),
          Container(
            color: AppTheme.cardSurface,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: [
                Tab(text: '${s.labBookingsTabNew} (${_newBookings.length})'),
                Tab(
                  text: '${s.labBookingsTabActive} (${_activeBookings.length})',
                ),
                Tab(
                  text:
                      '${s.labBookingsTabDone} (${_completedBookings.length})',
                ),
              ],
            ),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          _error!,
                          style: const TextStyle(color: Colors.red),
                        ),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: _fetchBookings,
                          child: Text(s.actionRetry),
                        ),
                      ],
                    ),
                  )
                : TabBarView(
                    controller: _tabController,
                    children: [
                      _buildBookingList(_newBookings, 'BOOKED'),
                      _buildBookingList(_activeBookings, 'ACTIVE'),
                      _buildBookingList(_completedBookings, 'COMPLETED'),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildBookingList(List<dynamic> bookings, String type) {
    final s = AppStrings.of(context);
    if (bookings.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.inbox_outlined, size: 48, color: Colors.grey.shade400),
            const SizedBox(height: 8),
            Text(
              '${s.labBookingsEmptyPrefix} $type',
              style: TextStyle(color: Colors.grey.shade600),
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _fetchBookings,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: bookings.length,
        itemBuilder: (context, i) => _buildBookingCard(bookings[i]),
      ),
    );
  }

  Widget _buildBookingCard(Map<String, dynamic> booking) {
    final s = AppStrings.of(context);
    final status = booking['status'] ?? 'BOOKED';
    final testNames = booking['test_names'] as List<dynamic>?;
    final customTests = booking['custom_test_names'] as String?;
    final collectionType = booking['collection_type'] ?? 'home';
    final minsSinceBooked =
        (booking['mins_since_booked'] as num?)?.toInt() ?? 0;
    final slaBreach = booking['sla_breached'] == true;
    final createdAt = booking['created_at'] != null
        ? DateFormat(
            'd MMM, h:mm a',
          ).format(DateTime.parse(booking['created_at']).toLocal())
        : '';

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      color: slaBreach ? Colors.red.shade50 : null,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            Row(
              children: [
                Expanded(
                  child: Text(
                    booking['booking_number'] ?? '#${booking['id']}',
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                    ),
                  ),
                ),
                _statusBadge(status),
              ],
            ),
            const SizedBox(height: 6),

            // Patient info
            Row(
              children: [
                const Icon(Icons.person, size: 14, color: Colors.grey),
                const SizedBox(width: 4),
                Text(
                  booking['patient_name'] ?? 'Unknown',
                  style: const TextStyle(fontSize: 13),
                ),
                const Spacer(),
                if (booking['patient_phone'] != null)
                  GestureDetector(
                    onTap: () => _callPhone(booking['patient_phone']),
                    child: Row(
                      children: [
                        const Icon(
                          Icons.phone,
                          size: 14,
                          color: AppTheme.primaryBlue,
                        ),
                        const SizedBox(width: 2),
                        Text(
                          booking['patient_phone'] ?? '',
                          style: const TextStyle(
                            fontSize: 12,
                            color: AppTheme.primaryBlue,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 4),

            // Tests
            if (testNames != null && testNames.isNotEmpty)
              Wrap(
                spacing: 4,
                runSpacing: 2,
                children: testNames.map<Widget>((t) {
                  return Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.blue.shade50,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text('$t', style: const TextStyle(fontSize: 11)),
                  );
                }).toList(),
              ),
            if (customTests != null && customTests.isNotEmpty)
              AppText(
                's4.dynamic.lab_bookings.tests_prefix',
                values: {'tests': customTests},
                style: const TextStyle(fontSize: 12),
              ),

            const SizedBox(height: 6),

            // Collection type + time
            Row(
              children: [
                Icon(
                  collectionType == 'home' ? Icons.home : Icons.local_hospital,
                  size: 14,
                  color: Colors.grey.shade600,
                ),
                const SizedBox(width: 4),
                Text(
                  collectionType == 'home'
                      ? s.labBookingsHomeCollection
                      : s.labBookingsWalkIn,
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
                const SizedBox(width: 12),
                Icon(
                  Icons.access_time,
                  size: 14,
                  color: slaBreach ? Colors.red : Colors.grey.shade600,
                ),
                const SizedBox(width: 4),
                Text(
                  minsSinceBooked > 60
                      ? '${(minsSinceBooked / 60).toStringAsFixed(1)}h ago'
                      : '${minsSinceBooked}m ago',
                  style: TextStyle(
                    fontSize: 12,
                    color: slaBreach ? Colors.red : Colors.grey.shade600,
                    fontWeight: slaBreach ? FontWeight.bold : FontWeight.normal,
                  ),
                ),
                if (slaBreach) ...[
                  const SizedBox(width: 4),
                  const Icon(Icons.warning, size: 14, color: Colors.red),
                ],
                const Spacer(),
                Text(
                  createdAt,
                  style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
                ),
              ],
            ),

            // Slip photo
            if (booking['slip_photo_url'] != null) ...[
              const SizedBox(height: 6),
              GestureDetector(
                onTap: () => _viewImage(booking['slip_photo_url']),
                child: Row(
                  children: [
                    Icon(Icons.photo, size: 14, color: Colors.blue.shade700),
                    const SizedBox(width: 4),
                    Text(
                      s.labBookingsViewSlip,
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.blue.shade700,
                        decoration: TextDecoration.underline,
                      ),
                    ),
                  ],
                ),
              ),
            ],

            // Cost
            if (booking['final_cost'] != null ||
                booking['estimated_cost'] != null) ...[
              const SizedBox(height: 4),
              Text(
                '₹${booking['final_cost'] ?? booking['estimated_cost']}',
                style: const TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 14,
                ),
              ),
            ],

            const Divider(height: 16),

            // Action buttons based on status
            _buildActions(booking),
          ],
        ),
      ),
    );
  }

  Widget _statusBadge(String status) {
    Color color;
    switch (status) {
      case 'BOOKED':
        color = Colors.orange;
        break;
      case 'CONFIRMED':
        color = Colors.blue;
        break;
      case 'DISPATCHED':
        color = Colors.indigo;
        break;
      case 'COLLECTED':
        color = Colors.purple;
        break;
      case 'PROCESSING':
        color = Colors.amber.shade700;
        break;
      case 'RESULT_READY':
        color = Colors.green;
        break;
      default:
        color = Colors.grey;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        status.replaceAll('_', ' '),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.bold,
          color: color,
        ),
      ),
    );
  }

  Widget _buildActions(Map<String, dynamic> booking) {
    final s = AppStrings.of(context);
    final status = booking['status'] ?? '';
    final id = booking['id'];

    switch (status) {
      case 'BOOKED':
        return Row(
          children: [
            Expanded(
              child: ElevatedButton.icon(
                onPressed: () => _showConfirmDialog(id, booking),
                icon: const Icon(Icons.check, size: 16),
                label: Text(s.labBookingsConfirmButton),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.green,
                  foregroundColor: Colors.white,
                ),
              ),
            ),
          ],
        );
      case 'CONFIRMED':
        return Row(
          children: [
            Expanded(
              child: ElevatedButton.icon(
                onPressed: () => _showDispatchDialog(id),
                icon: const Icon(Icons.local_shipping, size: 16),
                label: Text(s.labBookingsDispatchDialog),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.indigo,
                  foregroundColor: Colors.white,
                ),
              ),
            ),
          ],
        );
      case 'DISPATCHED':
        final investigationId = _intValue(booking['investigation_id']);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_sharingLocation && _trackingBookingId == id)
              Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: Colors.green.shade50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.green.shade200),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.my_location,
                      size: 14,
                      color: Colors.green.shade700,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      s.labBookingsSharingLocation,
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.green.shade700,
                      ),
                    ),
                  ],
                ),
              ),
            ElevatedButton.icon(
              onPressed: () => investigationId == null
                  ? _markCollected(id)
                  : _scanAndCollect(booking),
              icon: Icon(
                investigationId == null ? Icons.science : Icons.qr_code_scanner,
                size: 16,
              ),
              label: Text(
                investigationId == null
                    ? s.labBookingsMarkCollected
                    : 'Scan and collect',
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.purple,
                foregroundColor: Colors.white,
              ),
            ),
          ],
        );
      case 'COLLECTED':
        return Row(
          children: [
            Expanded(
              child: ElevatedButton.icon(
                onPressed: () => _startProcessing(id),
                icon: const Icon(Icons.hourglass_top, size: 16),
                label: Text(s.labBookingsStartProcessing),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.amber.shade700,
                  foregroundColor: Colors.white,
                ),
              ),
            ),
          ],
        );
      case 'PROCESSING':
        return Row(
          children: [
            Expanded(
              child: ElevatedButton.icon(
                onPressed: () => _showUploadResultDialog(id),
                icon: const Icon(Icons.upload_file, size: 16),
                label: Text(s.labBookingsUploadResult),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.teal,
                  foregroundColor: Colors.white,
                ),
              ),
            ),
          ],
        );
      case 'RESULT_READY':
        return Row(
          children: [
            if (booking['result_file_url'] != null)
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () async {
                    final url = Uri.parse(booking['result_file_url']);
                    if (await canLaunchUrl(url)) {
                      await launchUrl(
                        url,
                        mode: LaunchMode.externalApplication,
                      );
                    }
                  },
                  icon: const Icon(Icons.download, size: 16),
                  label: Text(s.labBookingsViewResult),
                ),
              ),
          ],
        );
      default:
        return const SizedBox.shrink();
    }
  }

  // ─── Action Dialogs ───────────────────────────────────────────────

  Future<void> _showConfirmDialog(int id, Map<String, dynamic> booking) async {
    final s = AppStrings.of(context);
    final notesCtrl = TextEditingController();
    final costCtrl = TextEditingController(
      text: booking['estimated_cost']?.toString() ?? '',
    );
    final actualTestsCtrl = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.labBookingsConfirmDialog),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: actualTestsCtrl,
                decoration: InputDecoration(
                  labelText: s.labBookingsActualTestsLabel,
                  hintText: s.labBookingsActualTestsHint,
                  isDense: true,
                ),
                maxLines: 2,
              ),
              const SizedBox(height: 12),
              TextField(
                controller: costCtrl,
                decoration: InputDecoration(
                  labelText: s.labBookingsFinalCostLabel,
                  isDense: true,
                ),
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 12),
              TextField(
                controller: notesCtrl,
                decoration: InputDecoration(
                  labelText: AppStrings.of(
                    context,
                  ).lookup('bed_sheet.section.notes'),
                  isDense: true,
                ),
                maxLines: 2,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(s.actionCancel),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(s.labBookingsConfirmButton),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    try {
      await MedicalApiService.confirmInvestigationBooking(id, {
        if (notesCtrl.text.isNotEmpty) 'confirmation_notes': notesCtrl.text,
        if (actualTestsCtrl.text.isNotEmpty)
          'actual_tests': actualTestsCtrl.text,
        if (costCtrl.text.isNotEmpty)
          'final_cost': double.tryParse(costCtrl.text),
      });
      _showSnack(s.labBookingsConfirmedToast);
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  Future<void> _showDispatchDialog(int id) async {
    final s = AppStrings.of(context);
    final phoneCtrl = TextEditingController();
    final notesCtrl = TextEditingController();

    final dispatched = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.labBookingsDispatchDialog),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: phoneCtrl,
              decoration: InputDecoration(
                labelText: s.labBookingsCollectorPhone,
                isDense: true,
              ),
              keyboardType: TextInputType.phone,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: notesCtrl,
              decoration: InputDecoration(
                labelText: AppStrings.of(
                  context,
                ).lookup('bed_sheet.section.notes'),
                isDense: true,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(s.actionCancel),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(s.labBookingsDispatchButton),
          ),
        ],
      ),
    );

    if (dispatched != true) return;

    try {
      await MedicalApiService.dispatchCollector(id, {
        if (phoneCtrl.text.isNotEmpty) 'collector_phone': phoneCtrl.text,
        if (notesCtrl.text.isNotEmpty) 'notes': notesCtrl.text,
      });
      _showSnack(s.labBookingsDispatchedToast);
      _startLocationSharing(id);
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  Future<void> _markCollected(int id) async {
    final s = AppStrings.of(context);
    try {
      await MedicalApiService.markSamplesCollected(id);
      _stopLocationSharing();
      _showSnack(s.labBookingsSamplesCollectedToast);
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  Future<void> _scanAndCollect(Map<String, dynamic> booking) async {
    final s = AppStrings.of(context);
    final investigationId = _intValue(booking['investigation_id']);
    final bookingId = _intValue(booking['id']);
    if (investigationId == null) {
      if (bookingId != null) await _markCollected(bookingId);
      return;
    }

    final params = <String, String>{};
    final patientUid = _nonEmptyString(
      booking['patient_uid'] ?? booking['patientUid'],
    );
    if (patientUid != null) params['patient_uid'] = patientUid;
    final uri = Uri(
      path: '/lab/specimen-scan/$investigationId',
      queryParameters: params.isEmpty ? null : params,
    );
    final collected = await context.push<bool>(uri.toString());
    if (collected != true || !mounted) return;

    _stopLocationSharing();
    if (bookingId != null) {
      try {
        await MedicalApiService.markSamplesCollected(bookingId);
      } catch (e) {
        _showSnack(
          'Specimen collected, but queue update failed: $e',
          isError: true,
        );
        _fetchBookings();
        return;
      }
    }
    _showSnack(s.labBookingsSamplesCollectedToast);
    _fetchBookings();
  }

  Future<void> _startProcessing(int id) async {
    final s = AppStrings.of(context);
    try {
      await MedicalApiService.startBookingProcessing(id);
      _showSnack(s.labBookingsProcessingStartedToast);
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  Future<void> _showUploadResultDialog(int id) async {
    final s = AppStrings.of(context);
    final notesCtrl = TextEditingController();
    PlatformFile? pickedFile;

    final uploaded = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(s.labBookingsUploadResult),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              OutlinedButton.icon(
                onPressed: () async {
                  final result = await FilePicker.pickFiles(
                    type: FileType.custom,
                    allowedExtensions: ['pdf', 'jpg', 'png', 'doc', 'docx'],
                  );
                  if (result != null) {
                    final fileSize = result.files.single.size;
                    const maxSizeBytes = 10 * 1024 * 1024; // 10 MB
                    if (fileSize > maxSizeBytes) {
                      if (ctx.mounted) {
                        ScaffoldMessenger.of(ctx).showSnackBar(
                          SnackBar(content: Text(s.investigationsFileTooLarge)),
                        );
                      }
                      return;
                    }
                    setDialogState(() => pickedFile = result.files.single);
                  }
                },
                icon: const Icon(Icons.attach_file),
                label: Text(pickedFile?.name ?? s.labBookingsSelectFile),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: notesCtrl,
                decoration: InputDecoration(
                  labelText: AppStrings.of(
                    context,
                  ).lookup('bed_sheet.section.notes'),
                  isDense: true,
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: Text(s.actionCancel),
            ),
            ElevatedButton(
              onPressed: pickedFile != null
                  ? () => Navigator.of(ctx).pop(true)
                  : null,
              child: const AppText('s4.lib.lab_bookings.upload'),
            ),
          ],
        ),
      ),
    );

    if (uploaded != true || pickedFile?.path == null) return;

    try {
      await MedicalApiService.uploadBookingResult(
        id,
        pickedFile!.path!,
        notes: notesCtrl.text.isNotEmpty ? notesCtrl.text : null,
        fileName: pickedFile!.name,
      );
      _showSnack(s.labBookingsResultUploadedToast);
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  void _callPhone(String phone) async {
    final uri = Uri.parse('tel:$phone');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri);
    }
  }

  void _viewImage(String url) {
    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        child: InteractiveViewer(
          child: Image.network(url, fit: BoxFit.contain),
        ),
      ),
    );
  }

  void _showSnack(String msg, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: isError ? Colors.red : Colors.green,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}
