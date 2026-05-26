import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/services/patient_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';
import '../../../l10n/app_strings.dart';

String _digitsOnly(String value) => value.replaceAll(RegExp(r'\D'), '');

/// Patient Records screen — Doctors/Nurses/Admin view patient records.
class PatientRecordsScreen extends StatefulWidget {
  final String? contextMode;

  const PatientRecordsScreen({super.key, this.contextMode});

  @override
  State<PatientRecordsScreen> createState() => _PatientRecordsScreenState();
}

class _PatientRecordsScreenState extends State<PatientRecordsScreen> {
  List<dynamic> _appointments = [];
  bool _loading = true;
  String? _error;
  final _searchCtrl = TextEditingController();
  String _searchQuery = '';
  bool get _isIpContext => widget.contextMode?.toLowerCase() == 'ip';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getMedicalRecords(limit: 50);
      final list = data['records'] as List? ?? data['data'] as List? ?? [];
      if (mounted) setState(() => _appointments = list);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _searchByPhone(String phone) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await MedicalApiService.getHealthRecordsByPhone(phone);
      final list = data['records'] as List? ?? data['data'] as List? ?? [];
      if (mounted) setState(() => _appointments = list);
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _showUploadRecordSheet() async {
    final formKey = GlobalKey<FormState>();
    final phoneCtrl = TextEditingController();
    final patientNameCtrl = TextEditingController();
    final titleCtrl = TextEditingController();
    final sourceCtrl = TextEditingController(text: 'Venkataeswara Hospitals');
    final notesCtrl = TextEditingController();
    var documentType = 'prior_record';
    DateTime? recordDate;
    String? pickedPath;
    String? pickedName;
    var submitting = false;
    var lookupBusy = false;
    var patientNameReadOnly = false;
    var lookupMessage = 'Enter phone, then tap Check';

    Future<void> lookupPatient(StateSetter setSheetState) async {
      final digits = _digitsOnly(phoneCtrl.text);
      final last10 = digits.length >= 10
          ? digits.substring(digits.length - 10)
          : digits;
      if (last10.length < 10) {
        setSheetState(() {
          lookupMessage = 'Enter a valid 10-digit phone number';
          patientNameReadOnly = false;
        });
        return;
      }

      setSheetState(() {
        lookupBusy = true;
        lookupMessage = 'Checking patient registry...';
      });

      try {
        final matches = await PatientApiService.search(
          phoneCtrl.text,
          limit: 10,
        );
        Map<String, dynamic>? exact;
        for (final patient in matches) {
          if (_digitsOnly(
            patient['phone']?.toString() ?? '',
          ).endsWith(last10)) {
            exact = patient;
            break;
          }
        }
        if (exact == null) {
          setSheetState(() {
            lookupBusy = false;
            patientNameReadOnly = false;
            lookupMessage = 'New patient - name will be used during upload';
          });
          return;
        }
        setSheetState(() {
          lookupBusy = false;
          patientNameReadOnly = true;
          patientNameCtrl.text = exact!['name']?.toString() ?? '';
          lookupMessage = 'Existing patient found';
        });
      } catch (_) {
        setSheetState(() {
          lookupBusy = false;
          patientNameReadOnly = false;
          lookupMessage = 'Could not check now; upload can still continue';
        });
      }
    }

    final uploaded = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) {
          final recordDateLabel = recordDate == null
              ? 'Record date'
              : DateFormat('yyyy-MM-dd').format(recordDate!);

          Future<void> submit() async {
            if (!formKey.currentState!.validate()) return;
            if (pickedPath == null) {
              ScaffoldMessenger.of(ctx).showSnackBar(
                const SnackBar(
                  content: Text('Attach a file or photo'),
                  backgroundColor: AppTheme.errorRed,
                ),
              );
              return;
            }
            setSheetState(() => submitting = true);
            try {
              await MedicalApiService.uploadPatientPriorRecord(
                patientPhone: phoneCtrl.text.trim(),
                patientName: patientNameCtrl.text.trim(),
                title: titleCtrl.text.trim(),
                documentType: documentType,
                filePath: pickedPath!,
                fileName: pickedName,
                sourceHospital: sourceCtrl.text.trim(),
                recordDate: recordDate == null
                    ? null
                    : DateFormat('yyyy-MM-dd').format(recordDate!),
                notes: notesCtrl.text.trim().isEmpty
                    ? null
                    : notesCtrl.text.trim(),
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
                          child: Text(
                            'Upload Prior Record',
                            style: TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close),
                          tooltip: 'Close',
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
                        labelText: 'Patient phone',
                        helperText: lookupMessage,
                        prefixIcon: const ExcludeSemantics(
                          child: Icon(Icons.phone_outlined),
                        ),
                        suffixIcon: lookupBusy
                            ? const Padding(
                                padding: EdgeInsets.all(12),
                                child: SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                              )
                            : TextButton(
                                onPressed: submitting
                                    ? null
                                    : () => lookupPatient(setSheetState),
                                child: const Text('Check'),
                              ),
                      ),
                      validator: (value) => _digitsOnly(value ?? '').length < 10
                          ? 'Enter a valid phone number'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: patientNameCtrl,
                      readOnly: patientNameReadOnly,
                      decoration: const InputDecoration(
                        labelText: 'Patient name',
                        prefixIcon: ExcludeSemantics(
                          child: Icon(Icons.person_outline),
                        ),
                      ),
                      validator: (value) => (value?.trim().length ?? 0) < 2
                          ? 'Enter patient name'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: titleCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Record title',
                        hintText: 'Old discharge summary, prior scan...',
                        prefixIcon: ExcludeSemantics(
                          child: Icon(Icons.title_outlined),
                        ),
                      ),
                      validator: (value) => (value?.trim().length ?? 0) < 3
                          ? 'Enter a title'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: documentType,
                      decoration: const InputDecoration(
                        labelText: 'Document type',
                        prefixIcon: ExcludeSemantics(
                          child: Icon(Icons.folder_copy_outlined),
                        ),
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: 'prior_record',
                          child: Text('Prior record'),
                        ),
                        DropdownMenuItem(
                          value: 'discharge_summary',
                          child: Text('Discharge summary'),
                        ),
                        DropdownMenuItem(
                          value: 'lab_report',
                          child: Text('Lab report'),
                        ),
                        DropdownMenuItem(
                          value: 'radiology',
                          child: Text('Radiology'),
                        ),
                        DropdownMenuItem(
                          value: 'prescription',
                          child: Text('Prescription'),
                        ),
                        DropdownMenuItem(value: 'other', child: Text('Other')),
                      ],
                      onChanged: submitting
                          ? null
                          : (value) => setSheetState(
                              () => documentType = value ?? documentType,
                            ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: sourceCtrl,
                            decoration: const InputDecoration(
                              labelText: 'Source hospital',
                              prefixIcon: ExcludeSemantics(
                                child: Icon(Icons.local_hospital_outlined),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: submitting
                                ? null
                                : () async {
                                    final picked = await showDatePicker(
                                      context: ctx,
                                      initialDate: recordDate ?? DateTime.now(),
                                      firstDate: DateTime(1950),
                                      lastDate: DateTime.now(),
                                    );
                                    if (picked != null) {
                                      setSheetState(() => recordDate = picked);
                                    }
                                  },
                            icon: const Icon(Icons.calendar_today_outlined),
                            label: Text(recordDateLabel),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            icon: const Icon(Icons.attach_file),
                            label: Text(pickedName ?? 'Choose file'),
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
                                    final file = result?.files.single;
                                    if (file?.path != null) {
                                      setSheetState(() {
                                        pickedPath = file!.path;
                                        pickedName = file.name;
                                      });
                                    }
                                  },
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: OutlinedButton.icon(
                            icon: const Icon(Icons.camera_alt_outlined),
                            label: const Text('Camera'),
                            onPressed: submitting
                                ? null
                                : () async {
                                    final picked = await ImagePicker()
                                        .pickImage(source: ImageSource.camera);
                                    if (picked != null) {
                                      setSheetState(() {
                                        pickedPath = picked.path;
                                        pickedName = picked.name;
                                      });
                                    }
                                  },
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: notesCtrl,
                      maxLines: 2,
                      decoration: const InputDecoration(
                        labelText: 'Notes (optional)',
                        prefixIcon: ExcludeSemantics(
                          child: Icon(Icons.notes_outlined),
                        ),
                      ),
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
                            : const Icon(
                                Icons.upload_file,
                                color: Colors.white,
                              ),
                        label: Text(
                          submitting ? 'Uploading...' : 'Upload Record',
                        ),
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
    titleCtrl.dispose();
    sourceCtrl.dispose();
    notesCtrl.dispose();

    if (uploaded == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Patient record uploaded'),
          backgroundColor: AppTheme.successGreen,
        ),
      );
      if (_searchCtrl.text.trim().isNotEmpty) {
        final digits = _digitsOnly(_searchCtrl.text);
        if (digits.length == 10) {
          await _searchByPhone(digits);
          return;
        }
      }
      _load();
    }
  }

  List<dynamic> get _filtered {
    if (_searchQuery.isEmpty) return _appointments;
    final q = _searchQuery.toLowerCase();
    return _appointments.where((a) {
      final name =
          (a['patientName'] ?? a['patient']?['name'] ?? a['title'] ?? '')
              .toString()
              .toLowerCase();
      final type = (a['record_type'] ?? a['type'] ?? a['appointmentType'] ?? '')
          .toString()
          .toLowerCase();
      return name.contains(q) || type.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return StaffScaffold(
      title: _isIpContext ? 'IP Patient Records' : s.patientRecordsTitle,
      body: _isIpContext ? _buildIpRecordsBody() : _buildStandardRecordsBody(s),
    );
  }

  Widget _buildIpRecordsBody() {
    return DefaultTabController(
      length: 2,
      child: Column(
        children: [
          Container(
            color: Colors.white,
            child: TabBar(
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: const [
                Tab(text: 'Current Admission Notes'),
                Tab(text: 'Prior Records'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              children: [
                const _CurrentAdmissionNotesTab(),
                _IpPriorRecordsTab(onUpload: _showUploadRecordSheet),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStandardRecordsBody(AppStrings s) {
    return Column(
      children: [
        // Search
        Container(
          color: Colors.white,
          padding: const EdgeInsets.all(12),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final searchField = TextField(
                controller: _searchCtrl,
                decoration: InputDecoration(
                  hintText: s.patientRecordsSearchHint,
                  prefixIcon: const ExcludeSemantics(child: Icon(Icons.search)),
                  suffixIcon: _searchQuery.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear),
                          tooltip: s.patientRecordsClearTooltip,
                          onPressed: () {
                            _searchCtrl.clear();
                            setState(() => _searchQuery = '');
                          },
                        )
                      : null,
                  filled: true,
                  fillColor: AppTheme.backgroundGrey,
                ),
                onChanged: (v) => setState(() => _searchQuery = v),
                onSubmitted: (v) {
                  final digits = _digitsOnly(v);
                  if (digits.length == 10) _searchByPhone(digits);
                },
              );
              final uploadButton = ElevatedButton.icon(
                onPressed: _showUploadRecordSheet,
                icon: const Icon(Icons.upload_file, color: Colors.white),
                label: const Text('Upload Prior Record'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.primaryBlue,
                  foregroundColor: Colors.white,
                  minimumSize: const Size(0, 50),
                ),
              );
              if (constraints.maxWidth < 560) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    searchField,
                    const SizedBox(height: 10),
                    uploadButton,
                  ],
                );
              }
              return Row(
                children: [
                  Expanded(child: searchField),
                  const SizedBox(width: 12),
                  uploadButton,
                ],
              );
            },
          ),
        ),

        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                ? _ErrorState(error: _error!, onRetry: _load)
                : _filtered.isEmpty
                ? _EmptyState(hasSearch: _searchQuery.isNotEmpty)
                : ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: _filtered.length,
                    itemBuilder: (ctx, i) => _PatientCard(record: _filtered[i]),
                  ),
          ),
        ),
      ],
    );
  }
}

List<Map<String, dynamic>> _mapListFrom(dynamic value) {
  if (value is Map) {
    return _mapListFrom(
      value['admissions'] ?? value['notes'] ?? value['items'] ?? value['data'],
    );
  }
  if (value is List) {
    return value
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
  }
  return const [];
}

String _firstText(List<dynamic> values, {String fallback = ''}) {
  for (final value in values) {
    final text = value?.toString().trim() ?? '';
    if (text.isNotEmpty && text.toLowerCase() != 'null') return text;
  }
  return fallback;
}

Map<String, dynamic> _contentMap(Map<String, dynamic> note) {
  final content = note['content'];
  return content is Map ? Map<String, dynamic>.from(content) : const {};
}

String _noteText(Map<String, dynamic> note, String key) {
  final direct = note[key];
  if (direct is String && direct.trim().isNotEmpty) return direct;
  final nested = _contentMap(note)[key];
  return nested is String && nested.trim().isNotEmpty ? nested : '';
}

String _noteSummary(Map<String, dynamic> note) {
  for (final key in const [
    'summary',
    'current_status',
    'assessment',
    'subjective',
    'procedure_details',
    'findings',
  ]) {
    final text = _noteText(note, key);
    if (text.isNotEmpty) return text;
  }
  final content = note['content'];
  if (content is String && content.trim().isNotEmpty) return content;
  return 'Clinical note';
}

DateTime? _parseDate(dynamic value) {
  final text = value?.toString() ?? '';
  return text.isEmpty ? null : DateTime.tryParse(text);
}

bool _isCurrentAdmissionNote(
  Map<String, dynamic> admission,
  Map<String, dynamic> note,
) {
  final admissionEncounter = _firstText([admission['encounter_id']]);
  final noteEncounter = _firstText([note['encounter_id']]);
  if (admissionEncounter.isNotEmpty && noteEncounter.isNotEmpty) {
    return admissionEncounter == noteEncounter;
  }

  final admittedAt = _parseDate(admission['admitted_at']);
  final createdAt = _parseDate(note['created_at']);
  if (admittedAt != null && createdAt != null) {
    return !createdAt.isBefore(admittedAt.subtract(const Duration(hours: 1)));
  }
  return true;
}

class _CurrentAdmissionNotesTab extends StatefulWidget {
  const _CurrentAdmissionNotesTab();

  @override
  State<_CurrentAdmissionNotesTab> createState() =>
      _CurrentAdmissionNotesTabState();
}

class _CurrentAdmissionNotesTabState extends State<_CurrentAdmissionNotesTab> {
  bool _loading = true;
  String? _error;
  List<_AdmissionNotesBundle> _bundles = const [];
  String? _expandedAdmissionKey;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final admissionsData = await MedicalApiService.getActiveAdmissions(
        limit: 50,
      );
      final admissions = _mapListFrom(admissionsData);
      final bundles = await Future.wait(
        admissions.map((admission) async {
          final uid = _firstText([admission['patient_uid']]);
          var notes = <Map<String, dynamic>>[];
          if (uid.isNotEmpty) {
            final notesData = await MedicalApiService.getPatientNotes(uid);
            notes = _mapListFrom(notesData)
                .where((note) => _isCurrentAdmissionNote(admission, note))
                .toList();
          }
          return _AdmissionNotesBundle(admission: admission, notes: notes);
        }),
      );
      if (!mounted) return;
      setState(() {
        _bundles = bundles;
        _expandedAdmissionKey = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return _ErrorState(error: _error!, onRetry: _load);
    if (_bundles.isEmpty) {
      return const _SimpleEmptyState(
        icon: Icons.local_hotel_outlined,
        title: 'No active admissions',
        body: 'Current admission notes will appear here.',
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _bundles.length,
        itemBuilder: (context, index) {
          final bundle = _bundles[index];
          final admissionKey = _admissionTileKey(bundle, index);
          return _AdmissionNotesCard(
            bundle: bundle,
            expansionKey: admissionKey,
            isExpanded: _expandedAdmissionKey == admissionKey,
            onExpansionChanged: (expanded) {
              setState(() {
                _expandedAdmissionKey = expanded ? admissionKey : null;
              });
            },
          );
        },
      ),
    );
  }

  String _admissionTileKey(_AdmissionNotesBundle bundle, int index) {
    final admission = bundle.admission;
    final stableId = _firstText([
      admission['admission_id'],
      admission['id'],
      admission['encounter_id'],
      admission['patient_uid'],
    ]);
    return stableId.isNotEmpty ? stableId : 'admission-$index';
  }
}

class _AdmissionNotesBundle {
  final Map<String, dynamic> admission;
  final List<Map<String, dynamic>> notes;

  const _AdmissionNotesBundle({required this.admission, required this.notes});
}

class _AdmissionNotesCard extends StatelessWidget {
  final _AdmissionNotesBundle bundle;
  final String expansionKey;
  final bool isExpanded;
  final ValueChanged<bool> onExpansionChanged;

  const _AdmissionNotesCard({
    required this.bundle,
    required this.expansionKey,
    required this.isExpanded,
    required this.onExpansionChanged,
  });

  @override
  Widget build(BuildContext context) {
    final admission = bundle.admission;
    final uid = _firstText([admission['patient_uid']]);
    final patientName = _firstText([
      admission['patient_name'],
      admission['name'],
    ], fallback: 'Patient');
    final bed = _firstText([admission['bed_number'], admission['bed_id']]);
    final ward = _firstText([admission['ward'], admission['bed_ward_name']]);
    final admittedAt = _firstText([admission['admitted_at']]);
    final routeName = Uri.encodeQueryComponent(patientName);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ExpansionTile(
        key: ValueKey('admission-notes-$expansionKey-$isExpanded'),
        initiallyExpanded: isExpanded,
        onExpansionChanged: onExpansionChanged,
        leading: const CircleAvatar(
          backgroundColor: Color(0xFFE3F2FD),
          child: Icon(Icons.note_alt_outlined, color: AppTheme.primaryBlue),
        ),
        title: Text(
          patientName,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        subtitle: Text(
          [
            if (bed.isNotEmpty) 'Bed $bed',
            if (ward.isNotEmpty) ward,
            if (admittedAt.isNotEmpty) admittedAt,
          ].join(' • '),
        ),
        trailing: Chip(label: Text('${bundle.notes.length} notes')),
        children: [
          if (bundle.notes.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: Text(
                'No notes recorded for this admission yet.',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            )
          else
            ...bundle.notes
                .take(5)
                .map((note) => _AdmissionNoteRow(note: note)),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
            child: SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: uid.isEmpty
                    ? null
                    : () => context.push('/emr/notes/$uid?name=$routeName'),
                icon: const Icon(Icons.open_in_new),
                label: const Text('Open Notes'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AdmissionNoteRow extends StatelessWidget {
  final Map<String, dynamic> note;

  const _AdmissionNoteRow({required this.note});

  @override
  Widget build(BuildContext context) {
    final type = _firstText([note['note_type']], fallback: 'note');
    final role = _firstText([note['author_role']], fallback: 'staff');
    final created = _firstText([note['created_at']]);
    return ListTile(
      dense: true,
      leading: const Icon(Icons.sticky_note_2_outlined),
      title: Text(
        '${type.toUpperCase()} • ${role.toUpperCase()}',
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        [_noteSummary(note), if (created.isNotEmpty) created].join('\n'),
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
      ),
    );
  }
}

class _IpPriorRecordsTab extends StatefulWidget {
  final Future<void> Function() onUpload;

  const _IpPriorRecordsTab({required this.onUpload});

  @override
  State<_IpPriorRecordsTab> createState() => _IpPriorRecordsTabState();
}

class _IpPriorRecordsTabState extends State<_IpPriorRecordsTab> {
  bool _loading = true;
  String? _error;
  List<_IpPriorRecord> _records = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final admissionsData = await MedicalApiService.getActiveAdmissions(
        limit: 50,
      );
      final admissions = _mapListFrom(admissionsData);
      final records = <_IpPriorRecord>[];
      for (final admission in admissions) {
        final uid = _firstText([admission['patient_uid']]);
        final phone = _firstText([
          admission['patient_phone'],
          admission['phone'],
        ]);
        if (uid.isEmpty && phone.isEmpty) continue;
        final data = await MedicalApiService.getPatientAllRecords(
          patientUid: uid.isEmpty ? null : uid,
          patientPhone: phone.isEmpty ? null : phone,
        );
        final docs = [
          ..._mapListFrom(data['hospital_records']),
          ..._mapListFrom(data['my_uploads']),
        ];
        records.addAll(
          docs.map(
            (record) => _IpPriorRecord(admission: admission, record: record),
          ),
        );
      }
      records.sort((a, b) {
        final ad = _firstText([
          a.record['record_date'],
          a.record['created_at'],
          a.record['uploaded_at'],
        ]);
        final bd = _firstText([
          b.record['record_date'],
          b.record['created_at'],
          b.record['uploaded_at'],
        ]);
        return bd.compareTo(ad);
      });
      if (!mounted) return;
      setState(() {
        _records = records;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _loading = false;
      });
    }
  }

  Future<void> _uploadAndRefresh() async {
    await widget.onUpload();
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return _ErrorState(error: _error!, onRetry: _load);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
          child: SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: _uploadAndRefresh,
              icon: const Icon(Icons.upload_file, color: Colors.white),
              label: const Text('Upload Prior Record'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppTheme.primaryBlue,
                foregroundColor: Colors.white,
              ),
            ),
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: _records.isEmpty
                ? const _SimpleEmptyState(
                    icon: Icons.folder_copy_outlined,
                    title: 'No prior records uploaded',
                    body:
                        'Photos and PDFs uploaded for admitted patients appear here.',
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: _records.length,
                    itemBuilder: (context, index) =>
                        _IpPriorRecordCard(item: _records[index]),
                  ),
          ),
        ),
      ],
    );
  }
}

class _IpPriorRecord {
  final Map<String, dynamic> admission;
  final Map<String, dynamic> record;

  const _IpPriorRecord({required this.admission, required this.record});
}

class _IpPriorRecordCard extends StatelessWidget {
  final _IpPriorRecord item;

  const _IpPriorRecordCard({required this.item});

  @override
  Widget build(BuildContext context) {
    final admission = item.admission;
    final record = item.record;
    final patientName = _firstText([
      admission['patient_name'],
      record['patient_name'],
    ], fallback: 'Patient');
    final type = _firstText([
      record['document_type'],
      record['type'],
    ], fallback: 'record');
    final title = _firstText([
      record['title'],
      record['file_name'],
    ], fallback: type);
    final fileName = _firstText([record['file_name']], fallback: 'Document');
    final fileUrl = _firstText([record['file_url']]);
    final source = _firstText([
      record['source_hospital'],
      record['source'],
      record['doctor_name'],
    ]);
    final date = _firstText([
      record['record_date'],
      record['created_at'],
      record['uploaded_at'],
    ]);
    final bed = _firstText([admission['bed_number']]);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: AppTheme.primaryBlue.withValues(alpha: 0.1),
          child: Icon(
            fileName.toLowerCase().endsWith('.pdf')
                ? Icons.picture_as_pdf_outlined
                : Icons.image_outlined,
            color: AppTheme.primaryBlue,
          ),
        ),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(
          [
            patientName,
            if (bed.isNotEmpty) 'Bed $bed',
            type,
            fileName,
            if (source.isNotEmpty) source,
            if (date.isNotEmpty) date,
          ].join(' • '),
        ),
        trailing: IconButton(
          tooltip: 'Open',
          icon: const Icon(Icons.open_in_new),
          onPressed: fileUrl.isEmpty
              ? null
              : () async {
                  final uri = Uri.tryParse(fileUrl);
                  if (uri != null && await canLaunchUrl(uri)) {
                    await launchUrl(uri, mode: LaunchMode.externalApplication);
                  }
                },
        ),
      ),
    );
  }
}

class _SimpleEmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;

  const _SimpleEmptyState({
    required this.icon,
    required this.title,
    required this.body,
  });

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 120),
        Icon(icon, size: 56, color: AppTheme.textSecondary),
        const SizedBox(height: 16),
        Text(
          title,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontWeight: FontWeight.bold,
            color: AppTheme.textPrimary,
            fontSize: 16,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          body,
          textAlign: TextAlign.center,
          style: TextStyle(color: AppTheme.textSecondary),
        ),
      ],
    );
  }
}

class _PatientCard extends StatelessWidget {
  final dynamic record;
  const _PatientCard({required this.record});

  @override
  Widget build(BuildContext context) {
    final patientName =
        record['title']?.toString() ??
        record['patientName']?.toString() ??
        record['patient']?['name']?.toString() ??
        AppStrings.of(context).patientRecordsUnknownPatient;
    final type =
        record['record_type']?.toString() ??
        record['type']?.toString() ??
        record['appointmentType']?.toString() ??
        '—';
    final department = record['department']?.toString() ?? '';
    final dateTime =
        record['created_at']?.toString() ??
        record['dateTime']?.toString() ??
        record['date']?.toString() ??
        '';
    final status = record['status']?.toString().toLowerCase() ?? 'active';
    final doctor =
        record['doctorName']?.toString() ?? record['doctor']?.toString() ?? '';

    Color statusColor = switch (status) {
      'confirmed' => AppTheme.successGreen,
      'completed' => AppTheme.primaryTeal,
      'cancelled' => AppTheme.errorRed,
      _ => AppTheme.warningAmber,
    };

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _showDetails(context),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    backgroundColor: AppTheme.primaryBlue.withValues(
                      alpha: 0.1,
                    ),
                    child: Text(
                      patientName.isNotEmpty
                          ? patientName[0].toUpperCase()
                          : '?',
                      style: const TextStyle(
                        color: AppTheme.primaryBlue,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          patientName,
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            color: AppTheme.textPrimary,
                            fontSize: 15,
                          ),
                        ),
                        Text(
                          type,
                          style: TextStyle(
                            fontSize: 12,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: statusColor.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      status.toUpperCase(),
                      style: TextStyle(
                        fontSize: 10,
                        color: statusColor,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                ],
              ),
              if (department.isNotEmpty ||
                  doctor.isNotEmpty ||
                  dateTime.isNotEmpty) ...[
                const SizedBox(height: 8),
                const Divider(height: 1),
                const SizedBox(height: 8),
                if (department.isNotEmpty)
                  _InfoRow(Icons.business_outlined, department),
                if (doctor.isNotEmpty)
                  _InfoRow(Icons.person_outlined, 'Dr. $doctor'),
                if (dateTime.isNotEmpty)
                  _InfoRow(Icons.schedule_outlined, dateTime),
              ],
            ],
          ),
        ),
      ),
    );
  }

  void _showDetails(BuildContext context) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _PatientDetailsSheet(record: record),
    );
  }
}

class _PatientDetailsSheet extends StatelessWidget {
  final dynamic record;
  const _PatientDetailsSheet({required this.record});

  @override
  Widget build(BuildContext context) {
    final patientName =
        record['patientName']?.toString() ??
        record['patient']?['name']?.toString() ??
        AppStrings.of(context).patientRecordsUnknownPatient;
    final phone =
        record['patient']?['phone']?.toString() ??
        record['phone']?.toString() ??
        '—';

    return DraggableScrollableSheet(
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      minChildSize: 0.4,
      expand: false,
      builder: (_, ctrl) => ListView(
        controller: ctrl,
        padding: const EdgeInsets.all(20),
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: Colors.grey[300],
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            patientName,
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 4),
          if (phone != '—')
            Text('📱 $phone', style: TextStyle(color: AppTheme.textSecondary)),
          const SizedBox(height: 16),
          Text(
            AppStrings.of(context).patientRecordsDetails,
            style: TextStyle(
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          ...record.entries
              .where(
                (e) =>
                    e.key != '_id' &&
                    e.key != 'id' &&
                    e.value != null &&
                    e.value.toString().isNotEmpty,
              )
              .map(
                (e) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 120,
                        child: Text(
                          e.key
                              .replaceAllMapped(
                                RegExp(r'([A-Z])'),
                                (m) => ' ${m[0]}',
                              )
                              .trim()
                              .capitalize(),
                          style: TextStyle(
                            color: AppTheme.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                      ),
                      Expanded(
                        child: Text(
                          e.value.toString(),
                          style: TextStyle(
                            color: AppTheme.textPrimary,
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  final IconData icon;
  final String text;
  const _InfoRow(this.icon, this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 3),
      child: Row(
        children: [
          Icon(icon, size: 14, color: AppTheme.textSecondary),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String error;
  final VoidCallback onRetry;
  const _ErrorState({required this.error, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, color: AppTheme.errorRed, size: 40),
          const SizedBox(height: 8),
          Text(
            error,
            style: TextStyle(color: AppTheme.textSecondary),
            textAlign: TextAlign.center,
          ),
          TextButton(
            onPressed: onRetry,
            child: Text(AppStrings.of(context).patientRecordsRetry),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final bool hasSearch;
  const _EmptyState({required this.hasSearch});

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.folder_shared_outlined,
            size: 56,
            color: AppTheme.textSecondary,
          ),
          const SizedBox(height: 16),
          Text(
            hasSearch ? s.patientRecordsNoFound : s.patientRecordsEmpty,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            s.patientRecordsEmptyBody,
            style: TextStyle(color: AppTheme.textSecondary),
          ),
        ],
      ),
    );
  }
}

extension StringExtension on String {
  String capitalize() =>
      isEmpty ? this : '${this[0].toUpperCase()}${substring(1)}';
}
