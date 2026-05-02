import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import '../../../core/services/api_client.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/logout_action.dart';

class BedBoardScreen extends StatefulWidget {
  const BedBoardScreen({super.key});

  @override
  State<BedBoardScreen> createState() => _BedBoardScreenState();
}

class _BedBoardScreenState extends State<BedBoardScreen> {
  List<Map<String, dynamic>> _wards = [];
  List<Map<String, dynamic>> _beds = [];
  String? _selectedWardId;
  String? _selectedWardName;
  String _searchQuery = '';
  bool _loadingWards = true;
  bool _loadingBeds = false;
  String? _error;

  StreamSubscription<RealtimeEvent>? _bedEventSub;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    _fetchWards();
    _attachRealtime();
  }

  Future<void> _attachRealtime() async {
    final rt = RealtimeClient.instance;
    await rt.connect();
    _bedEventSub = rt.events('staff:beds').listen((_) => _debouncedRefresh());
  }

  void _debouncedRefresh() {
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(const Duration(milliseconds: 400), () {
      if (!mounted) return;
      if (_selectedWardId != null) {
        _fetchBeds(_selectedWardId!);
      }
    });
  }

  @override
  void dispose() {
    _bedEventSub?.cancel();
    _refreshDebounce?.cancel();
    super.dispose();
  }

  Future<void> _fetchWards() async {
    setState(() {
      _loadingWards = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/wards');
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['wards'] ?? [] : []);
        _wards = List<Map<String, dynamic>>.from(
          (list as List).map(
            (w) => w is Map<String, dynamic> ? w : <String, dynamic>{},
          ),
        );
      } else {
        _error = response.message ?? 'Failed to load wards';
      }
    } catch (e) {
      _error = 'Could not connect to server';
    } finally {
      if (mounted) setState(() => _loadingWards = false);
    }
  }

  Future<void> _fetchBeds(String wardId) async {
    setState(() {
      _loadingBeds = true;
      _beds = [];
    });
    try {
      final response = await ApiClient.get('/beds/ward/$wardId');
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['beds'] ?? [] : []);
        _beds = List<Map<String, dynamic>>.from(
          (list as List).map(
            (b) => b is Map<String, dynamic> ? b : <String, dynamic>{},
          ),
        );
      }
    } catch (e) {
      debugPrint('bed_board_screen.dart: $e');
    } finally {
      if (mounted) setState(() => _loadingBeds = false);
    }
  }

  Color _statusColor(String? status) {
    switch (status?.toLowerCase()) {
      case 'available':
        return AppTheme.successGreen;
      case 'occupied':
        return AppTheme.errorRed;
      case 'maintenance':
        return const Color(0xFFF9A825);
      default:
        return Colors.grey;
    }
  }

  IconData _statusIcon(String? status) {
    switch (status?.toLowerCase()) {
      case 'available':
        return Icons.check_circle_outline;
      case 'occupied':
        return Icons.person;
      case 'maintenance':
        return Icons.build_circle_outlined;
      default:
        return Icons.bed;
    }
  }

  List<Map<String, dynamic>> get _filteredWards {
    if (_searchQuery.isEmpty) return _wards;
    final q = _searchQuery.toLowerCase();
    return _wards.where((w) {
      final name = (w['name'] ?? w['wardName'] ?? '').toString().toLowerCase();
      return name.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        title: const Text('Bed Board'),
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              _fetchWards();
              if (_selectedWardId != null) _fetchBeds(_selectedWardId!);
            },
          ),
          const LogoutAction(),
        ],
      ),
      body: _loadingWards
          ? const Center(child: CircularProgressIndicator())
          : _error != null
          ? _buildError()
          : _selectedWardId == null
          ? _buildWardList()
          : _buildBedGrid(),
    );
  }

  Widget _buildError() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
          const SizedBox(height: 16),
          Text(_error!, style: TextStyle(color: AppTheme.textSecondary)),
          const SizedBox(height: 16),
          ElevatedButton.icon(
            onPressed: _fetchWards,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ],
      ),
    );
  }

  Widget _buildWardList() {
    return Column(
      children: [
        // Search bar
        Padding(
          padding: const EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(
              hintText: 'Search wards...',
              prefixIcon: const Icon(Icons.search),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              filled: true,
              fillColor: Colors.white,
            ),
            onChanged: (v) => setState(() => _searchQuery = v),
          ),
        ),

        // Legend
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              _legendDot(AppTheme.successGreen, 'Available'),
              const SizedBox(width: 16),
              _legendDot(AppTheme.errorRed, 'Occupied'),
              const SizedBox(width: 16),
              _legendDot(const Color(0xFFF9A825), 'Maintenance'),
            ],
          ),
        ),
        const SizedBox(height: 8),

        // Ward list
        Expanded(
          child: _filteredWards.isEmpty
              ? Center(
                  child: Text(
                    'No wards found',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _fetchWards,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _filteredWards.length,
                    itemBuilder: (context, index) {
                      final ward = _filteredWards[index];
                      final name =
                          ward['name'] ??
                          ward['wardName'] ??
                          'Ward ${index + 1}';
                      final totalBeds = ward['totalBeds'] ?? ward['total'] ?? 0;
                      final available =
                          ward['availableBeds'] ?? ward['available'] ?? 0;
                      final occupied =
                          ward['occupiedBeds'] ?? ward['occupied'] ?? 0;
                      final wardId =
                          (ward['id'] ?? ward['_id'] ?? ward['wardId'] ?? '')
                              .toString();

                      return Card(
                        margin: const EdgeInsets.only(bottom: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: ListTile(
                          contentPadding: const EdgeInsets.all(16),
                          leading: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: AppTheme.primaryBlue.withValues(
                                alpha: 0.1,
                              ),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Icon(
                              Icons.local_hotel,
                              color: AppTheme.primaryBlue,
                            ),
                          ),
                          title: Text(
                            name.toString(),
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          subtitle: Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Row(
                              children: [
                                _miniStat('Total', '$totalBeds', Colors.grey),
                                const SizedBox(width: 12),
                                _miniStat(
                                  'Free',
                                  '$available',
                                  AppTheme.successGreen,
                                ),
                                const SizedBox(width: 12),
                                _miniStat(
                                  'Used',
                                  '$occupied',
                                  AppTheme.errorRed,
                                ),
                              ],
                            ),
                          ),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () {
                            setState(() {
                              _selectedWardId = wardId;
                              _selectedWardName = name.toString();
                            });
                            _fetchBeds(wardId);
                          },
                        ),
                      );
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget _buildBedGrid() {
    return Column(
      children: [
        // Header with back
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          color: Colors.white,
          child: Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => setState(() {
                  _selectedWardId = null;
                  _selectedWardName = null;
                  _beds = [];
                }),
              ),
              Text(
                _selectedWardName ?? 'Ward',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
              const Spacer(),
              Text(
                '${_beds.where((b) => (b['status'] ?? '').toString().toLowerCase() == 'available').length} available',
                style: const TextStyle(
                  color: AppTheme.successGreen,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 12),
            ],
          ),
        ),

        // Bed grid
        Expanded(
          child: _loadingBeds
              ? Center(child: CircularProgressIndicator())
              : _beds.isEmpty
              ? Center(
                  child: Text(
                    'No beds found in this ward',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: () => _fetchBeds(_selectedWardId!),
                  child: GridView.builder(
                    padding: const EdgeInsets.all(16),
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          mainAxisSpacing: 12,
                          crossAxisSpacing: 12,
                          childAspectRatio: 1.3,
                        ),
                    itemCount: _beds.length,
                    itemBuilder: (context, index) {
                      final bed = _beds[index];
                      return _buildBedCard(bed);
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget _buildBedCard(Map<String, dynamic> bed) {
    final status = (bed['status'] ?? 'available').toString();
    final bedNumber = bed['bedNumber'] ?? bed['bed_number'] ?? bed['number'] ?? bed['name'] ?? '';
    final patientName = bed['patient_full_name'] ??
        bed['patientName'] ??
        bed['patient_name'] ??
        bed['patient']?['name'] ??
        '';
    final doctorName = bed['attending_doctor_name'] ??
        bed['doctorName'] ??
        bed['doctor']?['name'] ??
        '';
    final hasNotes = (bed['notes'] ?? '').toString().trim().isNotEmpty;
    final color = _statusColor(status);

    final card = Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color, width: 2),
        boxShadow: [
          BoxShadow(
            color: color.withValues(alpha: 0.15),
            blurRadius: 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(_statusIcon(status), color: color, size: 20),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  'Bed $bedNumber',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    color: color,
                    fontSize: 14,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              // A tiny note pip so users see at a glance which beds
              // already have notes recorded — saves opening every sheet
              // to find the one with the handover note.
              if (hasNotes)
                Icon(Icons.sticky_note_2, size: 14, color: AppTheme.textSecondary),
            ],
          ),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              status.isNotEmpty
                  ? status[0].toUpperCase() + status.substring(1).toLowerCase()
                  : status,
              style: TextStyle(
                fontSize: 11,
                color: color,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          if (status.toLowerCase() == 'occupied' &&
              patientName.toString().isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              patientName.toString(),
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (doctorName.toString().isNotEmpty)
              Text(
                'Dr. $doctorName',
                style: TextStyle(
                  fontSize: 11,
                  color: AppTheme.textSecondary,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
          ],
        ],
      ),
    );

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _openBedSheet(bed),
        child: card,
      ),
    );
  }

  // Opens a modal bottom sheet with the bed's full context (patient +
  // admission details from the augmented `/beds/ward/:id` join) and a
  // notes textarea wired to PATCH /beds/:id/notes. After save, the
  // bed list is refreshed so the new note's pip indicator and any
  // realtime change shows up immediately.
  Future<void> _openBedSheet(Map<String, dynamic> bed) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppTheme.cardSurface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (sheetCtx) => _BedDetailSheet(
        bed: bed,
        wardName: _selectedWardName ?? '',
      ),
    );
    if (saved == true && _selectedWardId != null) {
      await _fetchBeds(_selectedWardId!);
    }
  }

  Widget _legendDot(Color color, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
        ),
      ],
    );
  }

  Widget _miniStat(String label, String value, Color color) {
    return Column(
      children: [
        Text(
          value,
          style: TextStyle(
            fontWeight: FontWeight.bold,
            color: color,
            fontSize: 14,
          ),
        ),
        Text(
          label,
          style: TextStyle(fontSize: 10, color: AppTheme.textSecondary),
        ),
      ],
    );
  }
}

/// Bottom sheet that opens when a bed card is tapped. Shows the bed
/// number, patient demographics, admission summary, and a notes
/// textarea. Save → PATCH /beds/:id/notes. Returns `true` from
/// `Navigator.pop` when notes were saved so the parent can refresh.
class _BedDetailSheet extends StatefulWidget {
  final Map<String, dynamic> bed;
  final String wardName;
  const _BedDetailSheet({required this.bed, required this.wardName});

  @override
  State<_BedDetailSheet> createState() => _BedDetailSheetState();
}

class _BedDetailSheetState extends State<_BedDetailSheet> {
  late final TextEditingController _notesCtrl;
  bool _saving = false;
  String? _saveError;

  @override
  void initState() {
    super.initState();
    _notesCtrl = TextEditingController(
      text: (widget.bed['notes'] ?? '').toString(),
    );
  }

  @override
  void dispose() {
    _notesCtrl.dispose();
    super.dispose();
  }

  String _bedId() => (widget.bed['id'] ?? widget.bed['_id'] ?? '').toString();

  String _capitalize(String s) =>
      s.isEmpty ? s : s[0].toUpperCase() + s.substring(1).toLowerCase();

  Color _statusColor(String? status) {
    switch (status?.toLowerCase()) {
      case 'available':
        return AppTheme.successGreen;
      case 'occupied':
        return AppTheme.errorRed;
      case 'maintenance':
        return const Color(0xFFF9A825);
      default:
        return Colors.grey;
    }
  }

  Future<void> _save() async {
    final id = _bedId();
    if (id.isEmpty) {
      setState(() => _saveError = 'Bed id missing — cannot save notes.');
      return;
    }
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      final response = await ApiClient.patch(
        '/beds/$id/notes',
        body: {'notes': _notesCtrl.text},
      );
      if (!mounted) return;
      if (response.isSuccess) {
        Navigator.of(context).pop(true);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Bed notes saved')),
        );
      } else {
        setState(() {
          _saveError = response.message ?? 'Failed to save notes';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _saveError = 'Could not connect to server');
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final bed = widget.bed;
    final status = (bed['status'] ?? 'available').toString();
    final bedNumber =
        bed['bedNumber'] ?? bed['bed_number'] ?? bed['number'] ?? bed['name'] ?? '';
    final bedType = (bed['bed_type'] ?? bed['bedType'] ?? '').toString();
    final color = _statusColor(status);
    final isOccupied = status.toLowerCase() == 'occupied';

    final patientName = (bed['patient_full_name'] ??
            bed['patientName'] ??
            bed['patient_name'] ??
            bed['patient']?['name'] ??
            '')
        .toString();
    final patientAge = bed['patient_age'];
    final patientGender = (bed['patient_gender'] ?? '').toString();
    final patientPhone = (bed['patient_phone'] ?? '').toString();
    final chiefComplaint = (bed['chief_complaint'] ?? '').toString();
    final admittingDx = (bed['admitting_diagnosis'] ?? '').toString();
    final admissionType = (bed['admission_type'] ?? '').toString();
    final priority = (bed['admission_priority'] ?? '').toString();
    final attendingDoctor =
        (bed['attending_doctor_name'] ?? bed['doctorName'] ?? '').toString();
    final admittedAt = (bed['admission_admitted_at'] ?? bed['admitted_at'] ?? '')
        .toString();

    final viewInsets = MediaQuery.of(context).viewInsets.bottom;

    return Padding(
      padding: EdgeInsets.only(bottom: viewInsets),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              // Drag handle
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 12),
                  decoration: BoxDecoration(
                    color: Colors.grey.shade300,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),

              // Header — bed + status
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Icon(Icons.local_hotel, color: color),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Bed $bedNumber',
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        Text(
                          [
                            widget.wardName,
                            if (bedType.isNotEmpty) _capitalize(bedType),
                          ].where((s) => s.isNotEmpty).join(' · '),
                          style: TextStyle(
                            fontSize: 13,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 5,
                    ),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      _capitalize(status),
                      style: TextStyle(
                        color: color,
                        fontWeight: FontWeight.w600,
                        fontSize: 12,
                      ),
                    ),
                  ),
                ],
              ),

              const SizedBox(height: 20),

              // Patient block (only when occupied)
              if (isOccupied && patientName.isNotEmpty) ...[
                _SectionHeader(label: 'Patient'),
                _DetailRow(
                  label: 'Name',
                  value: patientName,
                  icon: Icons.person_outline,
                ),
                if (patientAge != null && patientAge.toString().isNotEmpty)
                  _DetailRow(
                    label: 'Age',
                    value: '${patientAge.toString()} yr'
                        '${patientGender.isNotEmpty ? ' · ${_capitalize(patientGender)}' : ''}',
                    icon: Icons.cake_outlined,
                  )
                else if (patientGender.isNotEmpty)
                  _DetailRow(
                    label: 'Gender',
                    value: _capitalize(patientGender),
                    icon: Icons.cake_outlined,
                  ),
                if (patientPhone.isNotEmpty)
                  _DetailRow(
                    label: 'Phone',
                    value: patientPhone,
                    icon: Icons.phone_outlined,
                  ),
                const SizedBox(height: 16),

                // Admission block
                if (chiefComplaint.isNotEmpty ||
                    admittingDx.isNotEmpty ||
                    attendingDoctor.isNotEmpty ||
                    admissionType.isNotEmpty) ...[
                  _SectionHeader(label: 'Admission'),
                  if (chiefComplaint.isNotEmpty)
                    _DetailRow(
                      label: 'Chief complaint',
                      value: chiefComplaint,
                      icon: Icons.warning_amber_outlined,
                      multiline: true,
                    ),
                  if (admittingDx.isNotEmpty)
                    _DetailRow(
                      label: 'Diagnosis',
                      value: admittingDx,
                      icon: Icons.medical_information_outlined,
                      multiline: true,
                    ),
                  if (admissionType.isNotEmpty || priority.isNotEmpty)
                    _DetailRow(
                      label: 'Type',
                      value: [
                        if (admissionType.isNotEmpty) _capitalize(admissionType),
                        if (priority.isNotEmpty) _capitalize(priority),
                      ].join(' · '),
                      icon: Icons.label_outline,
                    ),
                  if (attendingDoctor.isNotEmpty)
                    _DetailRow(
                      label: 'Attending',
                      value: 'Dr. $attendingDoctor',
                      icon: Icons.medical_services_outlined,
                    ),
                  if (admittedAt.isNotEmpty)
                    _DetailRow(
                      label: 'Admitted',
                      value: admittedAt.replaceFirst('T', ' ').split('.').first,
                      icon: Icons.schedule_outlined,
                    ),
                  const SizedBox(height: 16),
                ],
              ] else ...[
                _SectionHeader(label: 'Patient'),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppTheme.backgroundGrey,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.info_outline, color: AppTheme.textSecondary),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          isOccupied
                              ? 'Patient details unavailable for this bed.'
                              : 'No patient currently assigned.',
                          style: TextStyle(color: AppTheme.textSecondary),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
              ],

              // Notes block
              _SectionHeader(label: 'Notes'),
              TextField(
                controller: _notesCtrl,
                minLines: 4,
                maxLines: 8,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(
                  hintText:
                      'Type a note for this bed (handover, hazards, IV site, etc.)',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                  filled: true,
                  fillColor: AppTheme.backgroundGrey,
                ),
              ),

              if (_saveError != null) ...[
                const SizedBox(height: 8),
                Text(
                  _saveError!,
                  style: TextStyle(color: AppTheme.errorRed, fontSize: 12),
                ),
              ],

              const SizedBox(height: 16),

              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _saving
                          ? null
                          : () => Navigator.of(context).pop(false),
                      child: const Text('Close'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _saving ? null : _save,
                      icon: _saving
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.save_outlined),
                      label: Text(_saving ? 'Saving…' : 'Save Notes'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String label;
  const _SectionHeader({required this.label});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: AppTheme.textSecondary,
          letterSpacing: 0.6,
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final bool multiline;
  const _DetailRow({
    required this.label,
    required this.value,
    required this.icon,
    this.multiline = false,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: multiline
            ? CrossAxisAlignment.start
            : CrossAxisAlignment.center,
        children: [
          Icon(icon, size: 18, color: AppTheme.textSecondary),
          const SizedBox(width: 10),
          SizedBox(
            width: 110,
            child: Text(
              label,
              style: TextStyle(
                fontSize: 12,
                color: AppTheme.textSecondary,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
