import 'package:flutter/material.dart';
import '../../../core/services/staff_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// EMR Clinical Notes screen — tabbed view for SOAP, Progress, and Procedure notes.
class ClinicalNotesScreen extends StatefulWidget {
  final String patientUid;
  final String? patientName;

  const ClinicalNotesScreen({
    super.key,
    required this.patientUid,
    this.patientName,
  });

  @override
  State<ClinicalNotesScreen> createState() => _ClinicalNotesScreenState();
}

class _ClinicalNotesScreenState extends State<ClinicalNotesScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  static const _noteTypes = ['soap', 'progress', 'procedure'];
  static const _tabLabels = ['SOAP Notes', 'Progress Notes', 'Procedure Notes'];

  final Map<String, List<Map<String, dynamic>>> _notesByType = {};
  final Map<String, bool> _loadingByType = {};
  final Map<String, String?> _errorByType = {};

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: _noteTypes.length, vsync: this);
    _tabController.addListener(() {
      if (!_tabController.indexIsChanging) {
        _loadNotesForTab(_tabController.index);
      }
    });
    // Load first tab
    _loadNotesForTab(0);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadNotesForTab(int index) async {
    final type = _noteTypes[index];
    if (_notesByType.containsKey(type) && _errorByType[type] == null) return;

    setState(() {
      _loadingByType[type] = true;
      _errorByType[type] = null;
    });

    try {
      final data = await StaffApiService.getPatientNotes(
        widget.patientUid,
        noteType: type,
      );
      final list = data['notes'];
      setState(() {
        _notesByType[type] = list is List
            ? list.map((e) => Map<String, dynamic>.from(e as Map)).toList()
            : [];
        _loadingByType[type] = false;
      });
    } catch (e) {
      setState(() {
        _errorByType[type] = e.toString();
        _loadingByType[type] = false;
      });
    }
  }

  void _refreshCurrentTab() {
    final type = _noteTypes[_tabController.index];
    _notesByType.remove(type);
    _loadNotesForTab(_tabController.index);
  }

  // ── Note Status Badge ──

  Widget _signedBadge(bool signed) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: signed
            ? AppTheme.successGreen.withOpacity(0.12)
            : AppTheme.warningAmber.withOpacity(0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        signed ? 'SIGNED' : 'UNSIGNED',
        style: TextStyle(
          color: signed ? AppTheme.successGreen : AppTheme.warningAmber,
          fontSize: 10,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  // ── Note List Tab ──

  Widget _buildNoteList(String type) {
    final loading = _loadingByType[type] ?? true;
    final error = _errorByType[type];
    final notes = _notesByType[type] ?? [];

    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
            const SizedBox(height: 12),
            Text(error, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: _refreshCurrentTab,
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    if (notes.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.note_alt_outlined, size: 64, color: AppTheme.divider),
            const SizedBox(height: 12),
            Text(
              'No ${type} notes found',
              style: const TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
        _notesByType.remove(type);
        await _loadNotesForTab(_tabController.index);
      },
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: notes.length,
        itemBuilder: (ctx, i) {
          final note = notes[i];
          final signed = note['signed'] == true;
          final noteId = note['id'];
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => _showNoteDetail(note),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            note['title'] as String? ??
                                '${type.toUpperCase()} Note',
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                              fontSize: 15,
                            ),
                          ),
                        ),
                        _signedBadge(signed),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Icon(Icons.person_outline,
                            size: 14, color: AppTheme.textSecondary),
                        const SizedBox(width: 4),
                        Text(
                          note['author_name'] as String? ?? 'Unknown',
                          style: const TextStyle(
                            fontSize: 12,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Icon(Icons.access_time,
                            size: 14, color: AppTheme.textSecondary),
                        const SizedBox(width: 4),
                        Text(
                          _formatTimestamp(note['created_at'] as String?),
                          style: const TextStyle(
                            fontSize: 12,
                            color: AppTheme.textSecondary,
                          ),
                        ),
                      ],
                    ),
                    if (note['summary'] != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        note['summary'] as String,
                        style: const TextStyle(fontSize: 13),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                    if (!signed && noteId is int) ...[
                      const SizedBox(height: 10),
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton.icon(
                          onPressed: () => _signNoteAction(noteId),
                          icon: const Icon(Icons.check_circle_outline, size: 18),
                          label: const Text('Sign Note'),
                          style: TextButton.styleFrom(
                            foregroundColor: AppTheme.successGreen,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  // ── Sign Note ──

  Future<void> _signNoteAction(int noteId) async {
    try {
      await StaffApiService.signNote(noteId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Note signed successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _refreshCurrentTab();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to sign note: $e'),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  // ── Note Detail ──

  void _showNoteDetail(Map<String, dynamic> note) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(ctx).size.height * 0.85,
        ),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: AppTheme.divider,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      note['title'] as String? ?? 'Clinical Note',
                      style: const TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                        color: AppTheme.textPrimary,
                      ),
                    ),
                  ),
                  _signedBadge(note['signed'] == true),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '${note['author_name'] ?? 'Unknown'} - ${_formatTimestamp(note['created_at'] as String?)}',
                style: const TextStyle(
                  color: AppTheme.textSecondary,
                  fontSize: 13,
                ),
              ),
              const Divider(height: 24),
              // SOAP fields
              if (note['subjective'] != null)
                _noteSection('Subjective', note['subjective'] as String),
              if (note['objective'] != null)
                _noteSection('Objective', note['objective'] as String),
              if (note['assessment'] != null)
                _noteSection('Assessment', note['assessment'] as String),
              if (note['plan'] != null)
                _noteSection('Plan', note['plan'] as String),
              // Generic content
              if (note['content'] != null)
                _noteSection('Content', note['content'] as String),
              if (note['findings'] != null)
                _noteSection('Findings', note['findings'] as String),
              if (note['procedure_details'] != null)
                _noteSection(
                    'Procedure Details', note['procedure_details'] as String),
              if (note['complications'] != null)
                _noteSection('Complications', note['complications'] as String),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }

  Widget _noteSection(String title, String content) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontWeight: FontWeight.w600,
              fontSize: 14,
              color: AppTheme.primaryBlue,
            ),
          ),
          const SizedBox(height: 4),
          Text(content, style: const TextStyle(fontSize: 14, height: 1.5)),
        ],
      ),
    );
  }

  // ── Create Note FAB ──

  void _showCreateNoteSheet() {
    final type = _noteTypes[_tabController.index];
    switch (type) {
      case 'soap':
        _showSoapNoteForm();
        break;
      case 'progress':
        _showProgressNoteForm();
        break;
      case 'procedure':
        _showProcedureNoteForm();
        break;
    }
  }

  void _showSoapNoteForm() {
    final formKey = GlobalKey<FormState>();
    final subjective = TextEditingController();
    final objective = TextEditingController();
    final assessment = TextEditingController();
    final plan = TextEditingController();

    _showNoteFormSheet(
      title: 'New SOAP Note',
      formKey: formKey,
      fields: [
        _buildTextArea(subjective, 'Subjective',
            'Patient complaints, symptoms, history...'),
        _buildTextArea(
            objective, 'Objective', 'Exam findings, vitals, lab results...'),
        _buildTextArea(
            assessment, 'Assessment', 'Diagnosis, clinical impression...'),
        _buildTextArea(plan, 'Plan', 'Treatment plan, orders, follow-up...'),
      ],
      onSubmit: () => _submitNote(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'note_type': 'soap',
          'subjective': subjective.text,
          'objective': objective.text,
          'assessment': assessment.text,
          'plan': plan.text,
        },
      ),
    );
  }

  void _showProgressNoteForm() {
    final formKey = GlobalKey<FormState>();
    final title = TextEditingController();
    final content = TextEditingController();

    _showNoteFormSheet(
      title: 'New Progress Note',
      formKey: formKey,
      fields: [
        TextFormField(
          controller: title,
          decoration: const InputDecoration(
            labelText: 'Title',
            border: OutlineInputBorder(),
          ),
          validator: (v) => (v == null || v.isEmpty) ? 'Required' : null,
        ),
        const SizedBox(height: 12),
        _buildTextArea(content, 'Content',
            'Clinical progress, observations, plan changes...'),
      ],
      onSubmit: () => _submitNote(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'note_type': 'progress',
          'title': title.text,
          'content': content.text,
        },
      ),
    );
  }

  void _showProcedureNoteForm() {
    final formKey = GlobalKey<FormState>();
    final title = TextEditingController();
    final procedureDetails = TextEditingController();
    final findings = TextEditingController();
    final complications = TextEditingController();

    _showNoteFormSheet(
      title: 'New Procedure Note',
      formKey: formKey,
      fields: [
        TextFormField(
          controller: title,
          decoration: const InputDecoration(
            labelText: 'Procedure Name',
            border: OutlineInputBorder(),
          ),
          validator: (v) => (v == null || v.isEmpty) ? 'Required' : null,
        ),
        const SizedBox(height: 12),
        _buildTextArea(procedureDetails, 'Procedure Details',
            'Technique, approach, steps...'),
        _buildTextArea(findings, 'Findings', 'Intra-procedural findings...'),
        _buildTextArea(
            complications, 'Complications', 'Any complications encountered...'),
      ],
      onSubmit: () => _submitNote(
        formKey: formKey,
        data: {
          'patient_uid': widget.patientUid,
          'note_type': 'procedure',
          'title': title.text,
          'procedure_details': procedureDetails.text,
          'findings': findings.text,
          'complications': complications.text,
        },
      ),
    );
  }

  Widget _buildTextArea(
      TextEditingController controller, String label, String hint) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        controller: controller,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          border: const OutlineInputBorder(),
          alignLabelWithHint: true,
        ),
        maxLines: 4,
        minLines: 3,
      ),
    );
  }

  void _showNoteFormSheet({
    required String title,
    required GlobalKey<FormState> formKey,
    required List<Widget> fields,
    required VoidCallback onSubmit,
  }) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Container(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(ctx).viewInsets.bottom,
        ),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Form(
            key: formKey,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(
                        color: AppTheme.divider,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 20),
                  ...fields,
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: onSubmit,
                      icon: const Icon(Icons.save),
                      label: const Text('Save Note'),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submitNote({
    required GlobalKey<FormState> formKey,
    required Map<String, dynamic> data,
  }) async {
    if (!formKey.currentState!.validate()) return;
    Navigator.of(context).pop();

    try {
      await StaffApiService.createClinicalNote(data);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Note created successfully'),
            backgroundColor: AppTheme.successGreen,
          ),
        );
        _refreshCurrentTab();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to create note: $e'),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    }
  }

  // ── Helpers ──

  String _formatTimestamp(String? ts) {
    if (ts == null) return '-';
    try {
      final dt = DateTime.parse(ts);
      final now = DateTime.now();
      final diff = now.difference(dt);
      if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
      if (diff.inHours < 24) return '${diff.inHours}h ago';
      return '${dt.day}/${dt.month}/${dt.year} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return ts;
    }
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: widget.patientName != null
          ? 'Notes - ${widget.patientName}'
          : 'Clinical Notes',
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _showCreateNoteSheet,
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.note_add),
        label: const Text('New Note'),
      ),
      body: Column(
        children: [
          Material(
            color: Colors.white,
            elevation: 1,
            child: TabBar(
              controller: _tabController,
              labelColor: AppTheme.primaryBlue,
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: AppTheme.primaryBlue,
              tabs: _tabLabels.map((l) => Tab(text: l)).toList(),
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: _noteTypes.map((t) => _buildNoteList(t)).toList(),
            ),
          ),
        ],
      ),
    );
  }
}
