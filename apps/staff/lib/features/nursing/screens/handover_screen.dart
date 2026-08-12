import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import '../../../core/config/api_config.dart';
import '../../../core/services/hr_api_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/prehospital_handover_api_service.dart';
import '../../../core/widgets/logout_action.dart';
import '../../../core/widgets/patient_context_chip.dart';
import '../../../core/widgets/realtime_status_banner.dart';
import '../../../core/widgets/states/success_toast.dart';
import '../../../core/widgets/voice_dictate_button.dart';
import '../../../l10n/app_strings.dart';

/// Handover Notes screen.
///
/// Optional prefill via route query params: `?patient_ref=&phone=`.
/// Used by the bed-board's "Handover" quick action to populate the
/// free-text patient reference field with `<ward> · Bed <num> — <name>`.
class HandoverScreen extends StatefulWidget {
  final String? prefillPatientRef;
  final String? prefillPhone;
  const HandoverScreen({super.key, this.prefillPatientRef, this.prefillPhone});

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
  List<Map<String, dynamic>> _prehospitalHandovers = [];
  bool _loadingNotes = true;
  bool _loadingPrehospital = true;
  int? _acceptingHandoverId;

  static const _departments = [
    'General',
    'Emergency',
    'ICU',
    'Pediatrics',
    'Surgery',
    'Outpatient',
  ];
  static const _urgencies = ['Low', 'Normal', 'High', 'Critical'];

  StreamSubscription<RealtimeEvent>? _handoverSub;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    if ((widget.prefillPatientRef ?? '').isNotEmpty) {
      _patientRefController.text = widget.prefillPatientRef!;
    }
    _loadRecentNotes();
    _loadPrehospitalHandovers();
    _attachRealtime();
  }

  Future<void> _attachRealtime() async {
    final rt = RealtimeClient.instance;
    await rt.connect();
    _handoverSub = rt.events('staff:handovers').listen((_) {
      _refreshDebounce?.cancel();
      _refreshDebounce = Timer(const Duration(milliseconds: 400), () {
        if (mounted) {
          _loadRecentNotes(showLoading: false);
          _loadPrehospitalHandovers(
            showLoading: false,
            preserveLastKnownData: true,
          );
        }
      });
    });
  }

  @override
  void dispose() {
    _handoverSub?.cancel();
    _refreshDebounce?.cancel();
    _tabController.dispose();
    _notesController.dispose();
    _patientRefController.dispose();
    super.dispose();
  }

  Future<void> _loadRecentNotes({bool showLoading = true}) async {
    if (showLoading) setState(() => _loadingNotes = true);
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

  Future<void> _loadPrehospitalHandovers({
    bool showLoading = true,
    bool preserveLastKnownData = false,
  }) async {
    if (showLoading && mounted) setState(() => _loadingPrehospital = true);
    try {
      final handovers =
          await PrehospitalHandoverApiService.listReadyForAcceptance();
      if (mounted) setState(() => _prehospitalHandovers = handovers);
    } catch (e) {
      if (mounted) {
        if (!preserveLastKnownData || _prehospitalHandovers.isEmpty) {
          setState(() => _prehospitalHandovers = const []);
        }
      }
    } finally {
      if (mounted) setState(() => _loadingPrehospital = false);
    }
  }

  Future<void> _acceptPrehospitalHandover(Map<String, dynamic> handover) async {
    final id = _handoverId(handover);
    if (id == null || _acceptingHandoverId != null) return;
    final s = AppStrings.of(context);
    setState(() => _acceptingHandoverId = id);
    try {
      await PrehospitalHandoverApiService.acceptHandover(
        handoverId: id,
        clinicalAttestation: s.handoverAmbulanceAttestation,
      );
      if (mounted) {
        SuccessToast.show(context, s.handoverAmbulanceAccepted);
        await _loadPrehospitalHandovers(showLoading: false);
      }
    } catch (e) {
      if (mounted) {
        ErrorToast.show(context, e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _acceptingHandoverId = null);
    }
  }

  Future<void> _submitNote() async {
    if (_submitting) return;
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
        SuccessToast.show(context, AppStrings.of(context).handoverSubmitted);
        _notesController.clear();
        _patientRefController.clear();
        _tabController.animateTo(1);
        unawaited(_loadRecentNotes());
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
    final s = AppStrings.of(context);
    final hasContext = (widget.prefillPatientRef ?? '').isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        leading: const NavigationBackAction(),
        title: Text(s.handoverTitle),
        actions: const [LogoutAction()],
        bottom: TabBar(
          controller: _tabController,
          tabs: [
            Tab(icon: const Icon(Icons.edit_note), text: s.handoverTabWrite),
            Tab(icon: const Icon(Icons.history), text: s.handoverTabRecent),
            Tab(
              icon: const Icon(Icons.local_shipping_outlined),
              text: s.handoverTabAmbulance,
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          RealtimeStatusBanner(
            watchChannels: const {'staff:handovers'},
            deniedMessageKey: 's4.lib.realtime_status.stale',
            fallbackPoll: _refreshHandoverBoards,
            margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
          ),
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
      children: [_buildWriteTab(), _buildRecentTab(), _buildAmbulanceTab()],
    );
  }

  Future<void> _refreshHandoverBoards() async {
    await Future.wait([
      _loadRecentNotes(showLoading: false),
      _loadPrehospitalHandovers(
        showLoading: false,
        preserveLastKnownData: true,
      ),
    ]);
  }

  Widget _buildWriteTab() {
    final s = AppStrings.of(context);
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
              decoration: InputDecoration(
                labelText: s.handoverDepartmentLabel,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.business)),
                border: const OutlineInputBorder(),
              ),
              items: _departments
                  .map(
                    (d) => DropdownMenuItem(
                      value: d,
                      child: Text(_departmentLabel(s, d)),
                    ),
                  )
                  .toList(),
              onChanged: (v) => setState(() => _department = v!),
            ),
            const SizedBox(height: 14),

            // Urgency
            DropdownButtonFormField<String>(
              initialValue: _urgency,
              decoration: InputDecoration(
                labelText: s.handoverUrgencyLabel,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.warning_amber),
                ),
                border: const OutlineInputBorder(),
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
                      Text(_urgencyLabel(s, u)),
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
              decoration: InputDecoration(
                labelText: s.handoverNotesLabel,
                hintText: s.handoverNotesHint,
                prefixIcon: const ExcludeSemantics(child: Icon(Icons.notes)),
                // Voice dictation — appends transcript onto the notes
                // controller. Useful during shift handovers when typing
                // is slower than speaking.
                suffixIcon: VoiceDictateButton(controller: _notesController),
                alignLabelWithHint: true,
                border: const OutlineInputBorder(),
              ),
              validator: (v) => (v == null || v.trim().isEmpty)
                  ? s.handoverNotesRequired
                  : null,
            ),
            const SizedBox(height: 14),

            // Patient references
            TextFormField(
              controller: _patientRefController,
              decoration: InputDecoration(
                labelText: s.handoverPatientRefLabel,
                hintText: s.handoverPatientRefHint,
                prefixIcon: const ExcludeSemantics(
                  child: Icon(Icons.person_search),
                ),
                border: const OutlineInputBorder(),
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
              label: Text(
                _submitting
                    ? s.handoverSubmittingButton
                    : s.handoverSubmitButton,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _departmentLabel(AppStrings s, String code) {
    switch (code) {
      case 'General':
        return s.departmentGeneral;
      case 'Emergency':
        return s.departmentEmergency;
      case 'ICU':
        return s.departmentIcu;
      case 'Pediatrics':
        return s.departmentPediatrics;
      case 'Surgery':
        return s.departmentSurgery;
      case 'Outpatient':
        return s.departmentOutpatient;
      default:
        return code;
    }
  }

  String _urgencyLabel(AppStrings s, String code) {
    switch (code) {
      case 'Low':
        return s.urgencyLow;
      case 'Normal':
        return s.urgencyNormal;
      case 'High':
        return s.urgencyHigh;
      case 'Critical':
        return s.urgencyCritical;
      default:
        return code;
    }
  }

  Widget _buildRecentTab() {
    final s = AppStrings.of(context);
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
            Text(
              s.handoverRecentEmptyTitle,
              style: const TextStyle(color: Colors.grey, fontSize: 15),
            ),
            const SizedBox(height: 4),
            Text(
              s.handoverRecentEmptyBody,
              style: const TextStyle(color: Colors.grey, fontSize: 12),
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
          final title = note['title'] ?? s.handoverNoteFallbackTitle;
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

  Widget _buildAmbulanceTab() {
    final s = AppStrings.of(context);
    if (_loadingPrehospital) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_prehospitalHandovers.isEmpty) {
      return RefreshIndicator(
        onRefresh: _loadPrehospitalHandovers,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(height: MediaQuery.sizeOf(context).height * 0.22),
            Icon(
              Icons.local_shipping_outlined,
              size: 64,
              color: Colors.grey.shade400,
            ),
            const SizedBox(height: 12),
            Text(
              s.handoverAmbulanceEmptyTitle,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.grey, fontSize: 15),
            ),
            const SizedBox(height: 4),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(
                s.handoverAmbulanceEmptyBody,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.grey, fontSize: 12),
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadPrehospitalHandovers,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _prehospitalHandovers.length,
        itemBuilder: (context, index) {
          final handover = _prehospitalHandovers[index];
          final id = _handoverId(handover);
          final accepting = id != null && _acceptingHandoverId == id;
          final title = _firstText([
            handover['handover_number'],
            handover['ambulance_request_number'],
            handover['presenting_complaint'],
          ]);
          final request = _firstText([
            handover['ambulance_request_number'],
            handover['ambulance_request_id'],
          ]);
          final eta = _firstText([
            handover['eta_latest_at'],
            handover['eta_first_at'],
          ]);
          final status = _textValue(handover['status']);

          return Card(
            margin: const EdgeInsets.only(bottom: 12),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      CircleAvatar(
                        backgroundColor: Theme.of(
                          context,
                        ).colorScheme.primaryContainer,
                        child: Icon(
                          Icons.emergency_share_outlined,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title.isEmpty ? s.handoverTabAmbulance : title,
                              style: const TextStyle(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            if (status.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 4),
                                child: Text(
                                  '${s.handoverAmbulanceStatus}: ${_displayStatus(status)}',
                                  style: TextStyle(
                                    color: Colors.grey.shade700,
                                    fontSize: 12,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  _handoverDetail(
                    s.handoverAmbulanceRequest,
                    request,
                    Icons.confirmation_number_outlined,
                  ),
                  _handoverDetail(
                    s.handoverAmbulancePatient,
                    _textValue(handover['patient_uid']),
                    Icons.person_outline,
                  ),
                  _handoverDetail(
                    s.handoverAmbulanceEta,
                    eta.isEmpty ? '' : _formatTimestamp(eta),
                    Icons.schedule,
                  ),
                  _handoverDetail(
                    s.handoverAmbulanceScene,
                    _textValue(handover['scene_observations']),
                    Icons.health_and_safety_outlined,
                  ),
                  _handoverDetail(
                    s.handoverAmbulanceAllergies,
                    _textValue(handover['allergies_reported']),
                    Icons.warning_amber,
                  ),
                  _handoverDetail(
                    s.handoverAmbulanceMeds,
                    _textValue(handover['medications_reported']),
                    Icons.medication_outlined,
                  ),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton.icon(
                      onPressed: accepting
                          ? null
                          : () => _acceptPrehospitalHandover(handover),
                      icon: accepting
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.verified_user_outlined),
                      label: Text(
                        accepting
                            ? s.handoverAmbulanceAccepting
                            : s.handoverAmbulanceAccept,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _handoverDetail(String label, String value, IconData icon) {
    if (value.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ExcludeSemantics(child: Icon(icon, size: 18, color: Colors.grey)),
          const SizedBox(width: 8),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: '$label: ',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  TextSpan(text: value),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  int? _handoverId(Map<String, dynamic> row) {
    final raw = row['id'];
    if (raw is int) return raw;
    return int.tryParse(raw?.toString() ?? '');
  }

  String _firstText(List<Object?> values) {
    for (final value in values) {
      final text = _textValue(value);
      if (text.isNotEmpty) return text;
    }
    return '';
  }

  String _displayStatus(String status) {
    final clean = status.replaceAll('_', ' ').trim();
    if (clean.isEmpty) return status;
    return clean[0].toUpperCase() + clean.substring(1);
  }

  String _textValue(Object? value) {
    if (value == null) return '';
    if (value is String) return value.trim();
    if (value is Iterable) {
      return value.map(_textValue).where((part) => part.isNotEmpty).join('; ');
    }
    if (value is Map) {
      return value.entries
          .map((entry) {
            final text = _textValue(entry.value);
            return text.isEmpty ? '' : '${entry.key}: $text';
          })
          .where((part) => part.isNotEmpty)
          .join('; ');
    }
    return value.toString().trim();
  }

  String _formatTimestamp(String ts) {
    final s = AppStrings.of(context);
    try {
      final dt = DateTime.parse(ts);
      final diff = DateTime.now().difference(dt);
      if (diff.inMinutes < 60) {
        return '${diff.inMinutes}${s.timeMinutesAgoSuffix}';
      }
      if (diff.inHours < 24) return '${diff.inHours}${s.timeHoursAgoSuffix}';
      return DateFormat('d MMM, HH:mm').format(dt);
    } catch (e) {
      return ts;
    }
  }
}
