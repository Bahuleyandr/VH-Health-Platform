import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../../core/providers/websocket_provider.dart';
import '../../../core/services/schedule_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../doctor/screens/prescriptions_screen.dart';

class AppointmentQueueScreen extends StatefulWidget {
  const AppointmentQueueScreen({super.key});

  @override
  State<AppointmentQueueScreen> createState() => _AppointmentQueueScreenState();
}

class _AppointmentQueueScreenState extends State<AppointmentQueueScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  List<dynamic> _queue = [];
  List<dynamic> _pending = [];
  bool _loadingQueue = true;
  bool _loadingPending = true;
  String? _queueError;
  String? _pendingError;
  int _lastSeenUpdateCount = 0;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _loadQueue();
    _loadPending();

    // Listen for WS appointment updates and auto-refresh
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final wsProv = context.read<WebSocketProvider>();
      _lastSeenUpdateCount = wsProv.appointmentUpdates.length;
      wsProv.addListener(_onWsUpdate);
    });
  }

  void _onWsUpdate() {
    if (!mounted) return;
    final wsProv = context.read<WebSocketProvider>();
    final updates = wsProv.appointmentUpdates;
    if (updates.length > _lastSeenUpdateCount) {
      _lastSeenUpdateCount = updates.length;
      // Auto-refresh both lists when a new appointment update arrives
      _loadQueue();
      _loadPending();
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadQueue() async {
    setState(() { _loadingQueue = true; _queueError = null; });
    try {
      final list = await ScheduleApiService.getTodayAppointmentQueue();
      if (mounted) setState(() => _queue = list);
    } catch (e) {
      if (mounted) setState(() => _queueError = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loadingQueue = false);
    }
  }

  Future<void> _loadPending() async {
    setState(() { _loadingPending = true; _pendingError = null; });
    try {
      final list = await ScheduleApiService.getPendingAppointments();
      if (mounted) setState(() => _pending = list);
    } catch (e) {
      if (mounted) setState(() => _pendingError = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loadingPending = false);
    }
  }

  // ── Status helpers ──────────────────────────────────────────────────────────

  Color _statusColor(String status) {
    switch (status.toUpperCase()) {
      case 'CONFIRMED': return AppTheme.primaryTeal;
      case 'COMPLETED': return Colors.green;
      case 'SCHEDULED': return Colors.orange;
      case 'NO_SHOW': return Colors.grey;
      case 'CANCELLED': return Colors.red;
      default: return Colors.blueGrey;
    }
  }

  // ── Confirm bottom sheet ────────────────────────────────────────────────────

  void _showConfirmSheet(Map<String, dynamic> appt) {
    final notesCtrl = TextEditingController();
    DateTime? selDate;
    TimeOfDay? selTime;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) {
        return StatefulBuilder(builder: (ctx, setSheet) {
          return Padding(
            padding: EdgeInsets.only(
              left: 20, right: 20, top: 20,
              bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Confirm Appointment',
                    style: Theme.of(ctx).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                Text(
                  '${appt['patient_name'] ?? 'Patient'} • ${appt['patient_phone'] ?? ''}',
                  style: Theme.of(ctx).textTheme.bodySmall?.copyWith(color: Colors.grey[600]),
                ),
                const SizedBox(height: 16),
                Row(children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.calendar_today, size: 16),
                      label: Text(selDate == null
                          ? 'Change Date'
                          : DateFormat('dd MMM yyyy').format(selDate!)),
                      onPressed: () async {
                        final d = await showDatePicker(
                          context: ctx,
                          initialDate: selDate ?? DateTime.now(),
                          firstDate: DateTime.now(),
                          lastDate: DateTime.now().add(const Duration(days: 90)),
                        );
                        if (d != null) setSheet(() => selDate = d);
                      },
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.access_time, size: 16),
                      label: Text(selTime == null
                          ? 'Change Time'
                          : selTime!.format(ctx)),
                      onPressed: () async {
                        final t = await showTimePicker(
                          context: ctx,
                          initialTime: selTime ?? TimeOfDay.now(),
                        );
                        if (t != null) setSheet(() => selTime = t);
                      },
                    ),
                  ),
                ]),
                const SizedBox(height: 12),
                TextField(
                  controller: notesCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Notes (optional)',
                    border: OutlineInputBorder(),
                  ),
                  maxLines: 2,
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.primaryTeal,
                      foregroundColor: Colors.white,
                    ),
                    onPressed: () async {
                      Navigator.pop(ctx);
                      await _confirmAppointment(
                        appt,
                        notes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim(),
                        date: selDate,
                        time: selTime,
                      );
                    },
                    child: const Text('Confirm Appointment'),
                  ),
                ),
              ],
            ),
          );
        });
      },
    );
  }

  Future<void> _confirmAppointment(
    Map<String, dynamic> appt, {
    String? notes,
    DateTime? date,
    TimeOfDay? time,
  }) async {
    final id = appt['id'];
    final data = <String, dynamic>{};
    if (notes != null) data['confirmation_notes'] = notes;
    if (date != null) data['appointment_date'] = DateFormat('yyyy-MM-dd').format(date);
    if (time != null) {
      final h = time.hour.toString().padLeft(2, '0');
      final m = time.minute.toString().padLeft(2, '0');
      data['appointment_time'] = '$h:$m';
    }
    try {
      await ScheduleApiService.confirmAppointment(id, data);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Appointment confirmed ✓'), backgroundColor: Colors.green),
        );
        _loadQueue();
        _loadPending();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed: ${e.toString().replaceFirst('Exception: ', '')}'),
              backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _markNoShow(Map<String, dynamic> appt) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Mark as No-Show?'),
        content: Text('${appt['patient_name'] ?? 'Patient'} did not show up?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.grey),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Mark No-Show'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ScheduleApiService.markNoShow(appt['id']);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Marked as no-show'), backgroundColor: Colors.grey),
        );
        _loadQueue();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed: $e'), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _completeAppointment(Map<String, dynamic> appt) async {
    final notesCtrl = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Complete Appointment'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Mark ${appt['patient_name'] ?? 'this appointment'} as completed?'),
            const SizedBox(height: 12),
            TextField(
              controller: notesCtrl,
              decoration: const InputDecoration(labelText: 'Notes (optional)', border: OutlineInputBorder()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.green),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Complete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ScheduleApiService.completeAppointmentStaff(
        appt['id'],
        notes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim(),
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Appointment completed ✓'), backgroundColor: Colors.green),
        );
        _loadQueue();
        // Show upload prescription prompt
        _promptUploadPrescription(appt);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed: $e'), backgroundColor: Colors.red),
        );
      }
    }
  }

  void _promptUploadPrescription(Map<String, dynamic> appt) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Create E-Prescription?'),
        content: const Text('Create a structured e-prescription for this visit? The patient can order medicines directly from it.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Skip')),
          OutlinedButton(
            onPressed: () {
              Navigator.pop(ctx);
              _showUploadDocSheet(appt);
            },
            child: const Text('Upload Doc'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppTheme.primaryTeal, foregroundColor: Colors.white),
            onPressed: () {
              Navigator.pop(ctx);
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => PrescriptionsScreen(prefilledAppointment: appt),
              ));
            },
            child: const Text('E-Prescription'),
          ),
        ],
      ),
    );
  }

  void _showUploadDocSheet(Map<String, dynamic> appt) {
    String docType = 'prescription';
    final docTypes = ['prescription', 'lab_report', 'radiology', 'other'];
    final notesCtrl = TextEditingController();
    File? pickedFile;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        return Padding(
          padding: EdgeInsets.only(
            left: 20, right: 20, top: 20,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Upload Document',
                  style: Theme.of(ctx).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: docType,
                decoration: const InputDecoration(labelText: 'Document Type', border: OutlineInputBorder()),
                items: docTypes.map((t) => DropdownMenuItem(
                  value: t,
                  child: Text(t.replaceAll('_', ' ').toUpperCase()),
                )).toList(),
                onChanged: (v) => setSheet(() => docType = v ?? docType),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: notesCtrl,
                decoration: const InputDecoration(labelText: 'Notes (optional)', border: OutlineInputBorder()),
                maxLines: 2,
              ),
              const SizedBox(height: 12),
              Row(children: [
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.attach_file),
                    label: Text(pickedFile == null ? 'Pick File' : pickedFile!.path.split('/').last),
                    onPressed: () async {
                      final picker = ImagePicker();
                      final picked = await picker.pickImage(source: ImageSource.gallery);
                      if (picked != null) setSheet(() => pickedFile = File(picked.path));
                    },
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.camera_alt),
                    label: const Text('Camera'),
                    onPressed: () async {
                      final picker = ImagePicker();
                      final picked = await picker.pickImage(source: ImageSource.camera);
                      if (picked != null) setSheet(() => pickedFile = File(picked.path));
                    },
                  ),
                ),
              ]),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryTeal,
                    foregroundColor: Colors.white,
                  ),
                  onPressed: pickedFile == null ? null : () async {
                    Navigator.pop(ctx);
                    try {
                      await ScheduleApiService.uploadAppointmentDocument(
                        appt['id'],
                        pickedFile!.path,
                        docType,
                        notes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim(),
                        fileName: pickedFile!.path.split('/').last,
                      );
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Document uploaded ✓'), backgroundColor: Colors.green),
                        );
                      }
                    } catch (e) {
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('Upload failed: $e'), backgroundColor: Colors.red),
                        );
                      }
                    }
                  },
                  child: const Text('Upload Document'),
                ),
              ),
            ],
          ),
        );
      }),
    );
  }

  // ── UI ───────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Appointment Queue',
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showWalkInDialog,
        backgroundColor: const Color(0xFF00796B),
        icon: const Icon(Icons.person_add, color: Colors.white),
        label: const Text('Walk-in', style: TextStyle(color: Colors.white)),
      ),
      body: Column(
        children: [
          TabBar(
            controller: _tabController,
            tabs: [
              Tab(text: "Today's Queue (${_queue.length})"),
              Tab(text: 'Pending (${_pending.length})'),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildQueueTab(),
                _buildPendingTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildQueueTab() {
    if (_loadingQueue) return const Center(child: CircularProgressIndicator());
    if (_queueError != null) return _errorWidget(_queueError!, _loadQueue);
    if (_queue.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.event_available, size: 64, color: Colors.grey),
            SizedBox(height: 12),
            Text('No appointments today', style: TextStyle(color: Colors.grey)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _loadQueue,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _queue.length,
        itemBuilder: (ctx, i) => _QueueCard(
          appt: _queue[i] as Map<String, dynamic>,
          statusColor: _statusColor,
          onConfirm: _showConfirmSheet,
          onNoShow: _markNoShow,
          onComplete: _completeAppointment,
          onUpload: _showUploadDocSheet,
        ),
      ),
    );
  }

  Widget _buildPendingTab() {
    if (_loadingPending) return const Center(child: CircularProgressIndicator());
    if (_pendingError != null) return _errorWidget(_pendingError!, _loadPending);
    if (_pending.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.check_circle_outline, size: 64, color: Colors.green),
            SizedBox(height: 12),
            Text('All appointments confirmed!', style: TextStyle(color: Colors.grey)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _loadPending,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _pending.length,
        itemBuilder: (ctx, i) => _PendingCard(
          appt: _pending[i] as Map<String, dynamic>,
          onConfirm: _showConfirmSheet,
        ),
      ),
    );
  }

  void _showWalkInDialog() {
    final phoneCtrl = TextEditingController();
    final nameCtrl = TextEditingController();
    final deptCtrl = TextEditingController();
    final reasonCtrl = TextEditingController();
    bool submitting = false;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        return Padding(
          padding: EdgeInsets.only(
            left: 20, right: 20, top: 20,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.person_add, color: Color(0xFF00796B)),
                  const SizedBox(width: 8),
                  const Text('Register Walk-in', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  const Spacer(),
                  IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: phoneCtrl,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                  labelText: 'Patient Phone *',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.phone),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: nameCtrl,
                decoration: const InputDecoration(
                  labelText: 'Patient Name',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.person),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: deptCtrl,
                decoration: const InputDecoration(
                  labelText: 'Department',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.local_hospital),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: reasonCtrl,
                decoration: const InputDecoration(
                  labelText: 'Reason',
                  border: OutlineInputBorder(),
                  hintText: 'Walk-in consultation',
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF00796B),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  onPressed: submitting ? null : () async {
                    if (phoneCtrl.text.trim().isEmpty) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Patient phone is required')),
                      );
                      return;
                    }
                    setSheet(() => submitting = true);
                    try {
                      final result = await ScheduleApiService.registerWalkIn(
                        patientPhone: phoneCtrl.text.trim(),
                        patientName: nameCtrl.text.trim(),
                        department: deptCtrl.text.trim(),
                        reason: reasonCtrl.text.trim(),
                      );
                      if (ctx.mounted) Navigator.pop(ctx);
                      final token = result['token_number'] ?? result['data']?['token_number'];
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text('Walk-in registered! Token #$token'),
                            backgroundColor: Colors.green,
                          ),
                        );
                        _loadQueue(); // Refresh queue
                      }
                    } catch (e) {
                      setSheet(() => submitting = false);
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('Failed: ${e.toString()}'), backgroundColor: Colors.red),
                        );
                      }
                    }
                  },
                  child: submitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                      : const Text('Register Walk-in', style: TextStyle(fontWeight: FontWeight.bold)),
                ),
              ),
            ],
          ),
        );
      }),
    );
  }

  Widget _errorWidget(String msg, VoidCallback onRetry) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(msg, style: const TextStyle(color: Colors.red), textAlign: TextAlign.center),
          const SizedBox(height: 12),
          ElevatedButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

// ── Queue Card ────────────────────────────────────────────────────────────────

class _QueueCard extends StatefulWidget {
  final Map<String, dynamic> appt;
  final Color Function(String) statusColor;
  final void Function(Map<String, dynamic>) onConfirm;
  final void Function(Map<String, dynamic>) onNoShow;
  final Future<void> Function(Map<String, dynamic>) onComplete;
  final void Function(Map<String, dynamic>) onUpload;

  const _QueueCard({
    required this.appt,
    required this.statusColor,
    required this.onConfirm,
    required this.onNoShow,
    required this.onComplete,
    required this.onUpload,
  });

  @override
  State<_QueueCard> createState() => _QueueCardState();
}

class _QueueCardState extends State<_QueueCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final appt = widget.appt;
    final status = (appt['status'] ?? 'SCHEDULED').toString().toUpperCase();
    final statusCol = widget.statusColor(status);
    final tokenNum = appt['token_number'];
    final theme = Theme.of(context);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        onTap: () => setState(() => _expanded = !_expanded),
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  if (tokenNum != null)
                    Container(
                      width: 36, height: 36,
                      decoration: BoxDecoration(
                        color: AppTheme.primaryTeal.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      alignment: Alignment.center,
                      child: Text('#$tokenNum',
                          style: const TextStyle(color: AppTheme.primaryTeal, fontWeight: FontWeight.bold)),
                    ),
                  if (tokenNum != null) const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(appt['patient_name'] ?? 'Patient',
                            style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                        Text(appt['patient_phone'] ?? '', style: theme.textTheme.bodySmall),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: statusCol.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(status,
                        style: TextStyle(color: statusCol, fontSize: 11, fontWeight: FontWeight.w600)),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Icon(Icons.access_time, size: 14, color: Colors.grey[600]),
                  const SizedBox(width: 4),
                  Text(appt['appointment_time'] ?? '', style: theme.textTheme.bodySmall),
                  const SizedBox(width: 16),
                  Icon(Icons.person, size: 14, color: Colors.grey[600]),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      appt['doctor_display_name'] ?? appt['doctor_name'] ?? '',
                      style: theme.textTheme.bodySmall,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              if (_expanded) ...[
                const Divider(height: 16),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    if (status == 'SCHEDULED')
                      ElevatedButton.icon(
                        icon: const Icon(Icons.check, size: 16),
                        label: const Text('Confirm'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: AppTheme.primaryTeal, foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        ),
                        onPressed: () => widget.onConfirm(appt),
                      ),
                    if (status == 'CONFIRMED')
                      ElevatedButton.icon(
                        icon: const Icon(Icons.done_all, size: 16),
                        label: const Text('Complete'),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.green, foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        ),
                        onPressed: () => widget.onComplete(appt),
                      ),
                    if (status != 'COMPLETED' && status != 'CANCELLED' && status != 'NO_SHOW')
                      OutlinedButton.icon(
                        icon: const Icon(Icons.person_off, size: 16),
                        label: const Text('No-Show'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.grey,
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        ),
                        onPressed: () => widget.onNoShow(appt),
                      ),
                    if (status == 'COMPLETED')
                      OutlinedButton.icon(
                        icon: const Icon(Icons.upload_file, size: 16),
                        label: const Text('Upload Doc'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: AppTheme.primaryTeal,
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                        ),
                        onPressed: () => widget.onUpload(appt),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

// ── Pending Card ──────────────────────────────────────────────────────────────

class _PendingCard extends StatelessWidget {
  final Map<String, dynamic> appt;
  final void Function(Map<String, dynamic>) onConfirm;

  const _PendingCard({required this.appt, required this.onConfirm});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final slaBreached = appt['sla_breached'] == true;
    final minsWaiting = (appt['minutes_since_booking'] ?? 0.0).toDouble();
    final waitStr = minsWaiting < 60
        ? '${minsWaiting.toInt()} min ago'
        : '${(minsWaiting / 60).toStringAsFixed(1)}h ago';

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: slaBreached
            ? const BorderSide(color: Colors.red, width: 1.5)
            : BorderSide.none,
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(appt['patient_name'] ?? 'Patient',
                          style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                      const SizedBox(height: 2),
                      Text(appt['patient_phone'] ?? '',
                          style: theme.textTheme.bodySmall?.copyWith(color: Colors.grey[600])),
                    ],
                  ),
                ),
                if (slaBreached)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.red.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Text('SLA BREACHED',
                        style: TextStyle(color: Colors.red, fontSize: 11, fontWeight: FontWeight.bold)),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Icon(Icons.schedule, size: 14, color: slaBreached ? Colors.red : Colors.grey),
                const SizedBox(width: 4),
                Text('Booked $waitStr',
                    style: TextStyle(
                      fontSize: 12,
                      color: slaBreached ? Colors.red : Colors.grey[600],
                      fontWeight: slaBreached ? FontWeight.w600 : FontWeight.normal,
                    )),
                const SizedBox(width: 16),
                Icon(Icons.calendar_today, size: 14, color: Colors.grey[600]),
                const SizedBox(width: 4),
                Text(
                  '${appt['appointment_date']?.toString().split('T').first ?? ''} ${appt['appointment_time'] ?? ''}',
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
            const SizedBox(height: 4),
            if (appt['doctor_name'] != null)
              Row(
                children: [
                  Icon(Icons.person, size: 14, color: Colors.grey[600]),
                  const SizedBox(width: 4),
                  Text(appt['doctor_name'], style: theme.textTheme.bodySmall),
                ],
              ),
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                icon: const Icon(Icons.check_circle_outline, size: 18),
                label: const Text('Call & Confirm'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: slaBreached ? Colors.red : AppTheme.primaryTeal,
                  foregroundColor: Colors.white,
                ),
                onPressed: () => onConfirm(appt),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
