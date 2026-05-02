import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/patient_context_chip.dart';
import '../../../core/widgets/states/success_toast.dart';

/// Handover Notes screen.
///
/// Optional prefill via route query params: `?patient_ref=&phone=`.
/// Used by the bed-board's "Handover" quick action to populate the
/// free-text patient reference field with `<ward> · Bed <num> — <name>`.
class HandoverScreen extends StatefulWidget {
  final String? prefillPatientRef;
  final String? prefillPhone;
  const HandoverScreen({
    super.key,
    this.prefillPatientRef,
    this.prefillPhone,
  });

  @override
  State<HandoverScreen> createState() => _HandoverScreenState();
}

class _HandoverScreenState extends State<HandoverScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  final _formKey = GlobalKey<FormState>();
  final _notesController = TextEditingController();
  final _patientRefController = TextEditingController();
  String _department = 'General';
  String _urgency = 'Normal';
  bool _submitting = false;
  List<Map<String, dynamic>> _recentNotes = [];
  bool _loadingNotes = true;

  static const _departments = [
    'General',
    'Emergency',
    'ICU',
    'Pediatrics',
    'Surgery',
    'Outpatient',
  ];
  static const _urgencies = ['Low', 'Normal', 'High', 'Critical'];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    if ((widget.prefillPatientRef ?? '').isNotEmpty) {
      _patientRefController.text = widget.prefillPatientRef!;
    }
    _loadRecentNotes();
  }

  @override
  void dispose() {
    _tabController.dispose();
    _notesController.dispose();
    _patientRefController.dispose();
    super.dispose();
  }

  Future<void> _loadRecentNotes() async {
    setState(() => _loadingNotes = true);
    try {
      // Fetch recent handover notes via notifications or consultations
      final phone = await ApiConfig.getPhone();
      if (phone != null) {
        final notifications = await HrApiService.getNotifications(phone);
        final notes = notifications
            .where((n) {
              final title = (n['title'] ?? '').toString().toLowerCase();
              final type = (n['type'] ?? '').toString().toLowerCase();
              return title.contains('handover') || type.contains('handover');
            })
            .take(20)
            .map((n) => n is Map<String, dynamic> ? n : <String, dynamic>{})
            .toList();
        if (mounted) setState(() => _recentNotes = notes);
      }
    } catch (e) {
      // Non-critical — recent notes may just be empty
    } finally {
      if (mounted) setState(() => _loadingNotes = false);
    }
  }

  Future<void> _submitNote() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      final phone = await ApiConfig.getPhone() ?? '';
      await MedicalApiService.uploadConsultation(
        phone: phone,
        consultationType: 'handover-note',
        notes: _notesController.text,
        additionalData: {
          'department': _department,
          'urgency': _urgency,
          'patientReferences': _patientRefController.text,
          'date': DateTime.now().toIso8601String(),
        },
      );
      if (mounted) {
        SuccessToast.show(context, 'Handover note submitted');
        _notesController.clear();
        _patientRefController.clear();
        _tabController.animateTo(1);
        _loadRecentNotes();
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasContext = (widget.prefillPatientRef ?? '').isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Handover Notes'),
        actions: const [LogoutAction()],
        bottom: TabBar(
          controller: _tabController,
          tabs: const [
            Tab(icon: Icon(Icons.edit_note), text: 'Write'),
            Tab(icon: Icon(Icons.history), text: 'Recent'),
          ],
        ),
      ),
      body: Column(
        children: [
          if (hasContext)
            PatientContextChip(
              name: widget.prefillPatientRef,
              phone: widget.prefillPhone,
              accent: const Color(0xFF6A1B9A),
            ),
          Expanded(child: _buildTabBody()),
        ],
      ),
    );
  }

  Widget _buildTabBody() {
    return TabBarView(
      controller: _tabController,
      children: [_buildWriteTab(), _buildRecentTab()],
    );
  }

  Widget _buildWriteTab() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Department
            DropdownButtonFormField<String>(
              initialValue: _department,
              decoration: const InputDecoration(
                labelText: 'Department',
                prefixIcon: Icon(Icons.business),
                border: OutlineInputBorder(),
              ),
              items: _departments
                  .map((d) => DropdownMenuItem(value: d, child: Text(d)))
                  .toList(),
              onChanged: (v) => setState(() => _department = v!),
            ),
            const SizedBox(height: 14),

            // Urgency
            DropdownButtonFormField<String>(
              initialValue: _urgency,
              decoration: const InputDecoration(
                labelText: 'Urgency',
                prefixIcon: Icon(Icons.warning_amber),
                border: OutlineInputBorder(),
              ),
              items: _urgencies.map((u) {
                final color = switch (u) {
                  'Critical' => Colors.red,
                  'High' => Colors.orange,
                  'Normal' => Colors.blue,
                  _ => Colors.grey,
                };
                return DropdownMenuItem(
                  value: u,
                  child: Row(
                    children: [
                      Icon(Icons.circle, size: 10, color: color),
                      const SizedBox(width: 8),
                      Text(u),
                    ],
                  ),
                );
              }).toList(),
              onChanged: (v) => setState(() => _urgency = v!),
            ),
            const SizedBox(height: 14),

            // Notes
            TextFormField(
              controller: _notesController,
              maxLines: 6,
              decoration: const InputDecoration(
                labelText: 'Handover Notes',
                hintText:
                    'Key observations, pending tasks, medication changes...',
                prefixIcon: Icon(Icons.notes),
                alignLabelWithHint: true,
                border: OutlineInputBorder(),
              ),
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Notes required' : null,
            ),
            const SizedBox(height: 14),

            // Patient references
            TextFormField(
              controller: _patientRefController,
              decoration: const InputDecoration(
                labelText: 'Patient References (optional)',
                hintText: 'Room 201 - Mr. Sharma, Room 305 - Mrs. Patel',
                prefixIcon: Icon(Icons.person_search),
                border: OutlineInputBorder(),
              ),
              maxLines: 2,
            ),
            const SizedBox(height: 20),

            FilledButton.icon(
              onPressed: _submitting ? null : _submitNote,
              icon: _submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Icon(Icons.send),
              label: Text(_submitting ? 'Submitting...' : 'Submit Handover'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRecentTab() {
    if (_loadingNotes) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_recentNotes.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.note_alt_outlined,
              size: 64,
              color: Colors.grey.shade400,
            ),
            const SizedBox(height: 12),
            const Text(
              'No recent handover notes',
              style: TextStyle(color: Colors.grey, fontSize: 15),
            ),
            const SizedBox(height: 4),
            const Text(
              'Notes from the last 24 hours will appear here',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadRecentNotes,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _recentNotes.length,
        itemBuilder: (context, index) {
          final note = _recentNotes[index];
          final title = note['title'] ?? 'Handover Note';
          final body = note['body'] ?? note['message'] ?? '';
          final time = note['createdAt'] ?? note['timestamp'] ?? '';
          final urgency = note['urgency'] ?? 'Normal';
          final urgencyColor = switch (urgency.toString()) {
            'Critical' => Colors.red,
            'High' => Colors.orange,
            'Normal' => Colors.blue,
            _ => Colors.grey,
          };

          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: urgencyColor.withValues(alpha: 0.1),
                child: Icon(Icons.swap_horiz, color: urgencyColor),
              ),
              title: Text(
                title.toString(),
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (body.toString().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        body.toString(),
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  if (time.toString().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        _formatTimestamp(time.toString()),
                        style: const TextStyle(
                          fontSize: 11,
                          color: Colors.grey,
                        ),
                      ),
                    ),
                ],
              ),
              isThreeLine: body.toString().isNotEmpty,
            ),
          );
        },
      ),
    );
  }

  String _formatTimestamp(String ts) {
    try {
      final dt = DateTime.parse(ts);
      final diff = DateTime.now().difference(dt);
      if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
      if (diff.inHours < 24) return '${diff.inHours}h ago';
      return DateFormat('d MMM, HH:mm').format(dt);
    } catch (e) {
      return ts;
    }
  }
}
