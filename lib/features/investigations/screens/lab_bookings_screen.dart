import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

class LabBookingsScreen extends StatefulWidget {
  const LabBookingsScreen({super.key});

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
  int? _trackingBookingId;
  bool _sharingLocation = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _fetchBookings();
  }

  @override
  void dispose() {
    _stopLocationSharing();
    _tabController.dispose();
    super.dispose();
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

  void _stopLocationSharing() {
    _locationTimer?.cancel();
    _locationTimer = null;
    if (_trackingBookingId != null && _sharingLocation) {
      StaffApiService.stopDeliveryTracking(
        orderType: 'investigation',
        orderId: _trackingBookingId!,
      ).catchError((_) {});
    }
    _trackingBookingId = null;
    _sharingLocation = false;
    if (mounted) setState(() {});
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
      await StaffApiService.updateDeliveryLocation(
        orderType: 'investigation',
        orderId: _trackingBookingId!,
        lat: pos.latitude,
        lng: pos.longitude,
        accuracy: pos.accuracy,
        speed: pos.speed * 3.6,
        heading: pos.heading,
      );
    } catch (e) { debugPrint('lab_bookings_screen.dart: $e'); }
  }

  Future<void> _fetchBookings() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await StaffApiService.getInvestigationBookingQueue();
      final data = (result['data'] ?? result);
      setState(() {
        _bookings = data is List ? data : [];
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  List<dynamic> get _newBookings =>
      _bookings.where((b) => b['status'] == 'BOOKED').toList();

  List<dynamic> get _activeBookings => _bookings
      .where((b) => ['CONFIRMED', 'DISPATCHED', 'COLLECTED', 'PROCESSING']
          .contains(b['status']))
      .toList();

  List<dynamic> get _completedBookings =>
      _bookings.where((b) => b['status'] == 'RESULT_READY').toList();

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Lab Bookings',
      body: Column(
        children: [
          Container(
            color: Colors.white,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: [
                Tab(text: 'New (${_newBookings.length})'),
                Tab(text: 'Active (${_activeBookings.length})'),
                Tab(text: 'Done (${_completedBookings.length})'),
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
                            Text(_error!,
                                style: const TextStyle(color: Colors.red)),
                            const SizedBox(height: 16),
                            ElevatedButton(
                              onPressed: _fetchBookings,
                              child: const Text('Retry'),
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
    if (bookings.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.inbox_outlined,
                size: 48, color: Colors.grey.shade400),
            const SizedBox(height: 8),
            Text('No $type bookings',
                style: TextStyle(color: Colors.grey.shade600)),
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
    final status = booking['status'] ?? 'BOOKED';
    final testNames = booking['test_names'] as List<dynamic>?;
    final customTests = booking['custom_test_names'] as String?;
    final collectionType = booking['collection_type'] ?? 'home';
    final minsSinceBooked =
        (booking['mins_since_booked'] as num?)?.toInt() ?? 0;
    final slaBreach = booking['sla_breached'] == true;
    final createdAt = booking['created_at'] != null
        ? DateFormat('d MMM, h:mm a')
            .format(DateTime.parse(booking['created_at']).toLocal())
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
                        fontWeight: FontWeight.bold, fontSize: 15),
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
                Text(booking['patient_name'] ?? 'Unknown',
                    style: const TextStyle(fontSize: 13)),
                const Spacer(),
                if (booking['patient_phone'] != null)
                  GestureDetector(
                    onTap: () => _callPhone(booking['patient_phone']),
                    child: Row(
                      children: [
                        const Icon(Icons.phone,
                            size: 14, color: AppTheme.primaryBlue),
                        const SizedBox(width: 2),
                        Text(booking['patient_phone'] ?? '',
                            style: const TextStyle(
                                fontSize: 12, color: AppTheme.primaryBlue)),
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
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: Colors.blue.shade50,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text('$t',
                        style: const TextStyle(fontSize: 11)),
                  );
                }).toList(),
              ),
            if (customTests != null && customTests.isNotEmpty)
              Text('Tests: $customTests',
                  style: const TextStyle(fontSize: 12)),

            const SizedBox(height: 6),

            // Collection type + time
            Row(
              children: [
                Icon(
                  collectionType == 'home'
                      ? Icons.home
                      : Icons.local_hospital,
                  size: 14,
                  color: Colors.grey.shade600,
                ),
                const SizedBox(width: 4),
                Text(
                  collectionType == 'home' ? 'Home' : 'Walk-in',
                  style: TextStyle(
                      fontSize: 12, color: Colors.grey.shade600),
                ),
                const SizedBox(width: 12),
                Icon(Icons.access_time, size: 14,
                    color: slaBreach ? Colors.red : Colors.grey.shade600),
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
                Text(createdAt,
                    style:
                        TextStyle(fontSize: 11, color: Colors.grey.shade500)),
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
                    Text('View Prescription Slip',
                        style: TextStyle(
                            fontSize: 12,
                            color: Colors.blue.shade700,
                            decoration: TextDecoration.underline)),
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
                    fontWeight: FontWeight.bold, fontSize: 14),
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
            fontSize: 11, fontWeight: FontWeight.bold, color: color),
      ),
    );
  }

  Widget _buildActions(Map<String, dynamic> booking) {
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
                label: const Text('Confirm'),
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
                label: const Text('Dispatch Collector'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.indigo,
                  foregroundColor: Colors.white,
                ),
              ),
            ),
          ],
        );
      case 'DISPATCHED':
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
                    Icon(Icons.my_location, size: 14, color: Colors.green.shade700),
                    const SizedBox(width: 4),
                    Text('📍 Sharing location...',
                        style: TextStyle(fontSize: 12, color: Colors.green.shade700)),
                  ],
                ),
              ),
            ElevatedButton.icon(
              onPressed: () => _markCollected(id),
              icon: const Icon(Icons.science, size: 16),
              label: const Text('Mark Collected'),
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
                label: const Text('Start Processing'),
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
                label: const Text('Upload Result'),
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
                      await launchUrl(url,
                          mode: LaunchMode.externalApplication);
                    }
                  },
                  icon: const Icon(Icons.download, size: 16),
                  label: const Text('View Result'),
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
    final notesCtrl = TextEditingController();
    final costCtrl = TextEditingController(
      text: booking['estimated_cost']?.toString() ?? '',
    );
    final actualTestsCtrl = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Confirm Booking'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: actualTestsCtrl,
                decoration: const InputDecoration(
                  labelText: 'Actual Tests (if different)',
                  hintText: 'Verify/add test names',
                  isDense: true,
                ),
                maxLines: 2,
              ),
              const SizedBox(height: 12),
              TextField(
                controller: costCtrl,
                decoration: const InputDecoration(
                  labelText: 'Final Cost (₹)',
                  isDense: true,
                ),
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 12),
              TextField(
                controller: notesCtrl,
                decoration: const InputDecoration(
                  labelText: 'Notes',
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
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Confirm'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    try {
      await StaffApiService.confirmInvestigationBooking(id, {
        if (notesCtrl.text.isNotEmpty) 'confirmation_notes': notesCtrl.text,
        if (actualTestsCtrl.text.isNotEmpty)
          'actual_tests': actualTestsCtrl.text,
        if (costCtrl.text.isNotEmpty)
          'final_cost': double.tryParse(costCtrl.text),
      });
      _showSnack('Booking confirmed');
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  Future<void> _showDispatchDialog(int id) async {
    final phoneCtrl = TextEditingController();
    final notesCtrl = TextEditingController();

    final dispatched = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Dispatch Collector'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: phoneCtrl,
              decoration: const InputDecoration(
                labelText: 'Collector Phone',
                isDense: true,
              ),
              keyboardType: TextInputType.phone,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: notesCtrl,
              decoration: const InputDecoration(
                labelText: 'Notes',
                isDense: true,
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Dispatch'),
          ),
        ],
      ),
    );

    if (dispatched != true) return;

    try {
      await StaffApiService.dispatchCollector(id, {
        if (phoneCtrl.text.isNotEmpty) 'collector_phone': phoneCtrl.text,
        if (notesCtrl.text.isNotEmpty) 'notes': notesCtrl.text,
      });
      _showSnack('Collector dispatched');
      _startLocationSharing(id);
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  Future<void> _markCollected(int id) async {
    try {
      await StaffApiService.markSamplesCollected(id);
      _stopLocationSharing();
      _showSnack('Samples collected');
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  Future<void> _startProcessing(int id) async {
    try {
      await StaffApiService.startBookingProcessing(id);
      _showSnack('Processing started');
      _fetchBookings();
    } catch (e) {
      _showSnack('Error: $e', isError: true);
    }
  }

  Future<void> _showUploadResultDialog(int id) async {
    final notesCtrl = TextEditingController();
    PlatformFile? pickedFile;

    final uploaded = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Upload Result'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              OutlinedButton.icon(
                onPressed: () async {
                  final result = await FilePicker.platform.pickFiles(
                    type: FileType.custom,
                    allowedExtensions: ['pdf', 'jpg', 'png', 'doc', 'docx'],
                  );
                  if (result != null) {
                    final fileSize = result.files.single.size;
                    const maxSizeBytes = 10 * 1024 * 1024; // 10 MB
                    if (fileSize > maxSizeBytes) {
                      if (ctx.mounted) {
                        ScaffoldMessenger.of(ctx).showSnackBar(
                          const SnackBar(
                            content: Text('File too large. Maximum size is 10 MB.'),
                          ),
                        );
                      }
                      return;
                    }
                    setDialogState(
                        () => pickedFile = result.files.single);
                  }
                },
                icon: const Icon(Icons.attach_file),
                label: Text(pickedFile?.name ?? 'Select File'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: notesCtrl,
                decoration: const InputDecoration(
                  labelText: 'Notes',
                  isDense: true,
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: pickedFile != null
                  ? () => Navigator.of(ctx).pop(true)
                  : null,
              child: const Text('Upload'),
            ),
          ],
        ),
      ),
    );

    if (uploaded != true || pickedFile?.path == null) return;

    try {
      await StaffApiService.uploadBookingResult(
        id,
        pickedFile!.path!,
        notes: notesCtrl.text.isNotEmpty ? notesCtrl.text : null,
        fileName: pickedFile!.name,
      );
      _showSnack('Result uploaded');
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
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: isError ? Colors.red : Colors.green,
      behavior: SnackBarBehavior.floating,
    ));
  }
}
