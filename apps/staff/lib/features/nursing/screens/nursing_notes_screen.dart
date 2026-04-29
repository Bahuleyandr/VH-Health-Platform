import 'package:flutter/material.dart';
import '../../../core/services/connectivity_sync_service.dart';
import '../../../core/services/medical_api_service.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/widgets/staff_scaffold.dart';

/// Nursing Notes screen — for Nursing Staff to add clinical notes per patient.
/// TODO: Integrate with backend when /staff/nursing/notes endpoint is available.
class NursingNotesScreen extends StatefulWidget {
  const NursingNotesScreen({super.key});

  @override
  State<NursingNotesScreen> createState() => _NursingNotesScreenState();
}

class _NursingNotesScreenState extends State<NursingNotesScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StaffScaffold(
      title: 'Nursing Notes',
      body: Column(
        children: [
          Container(
            color: Colors.white,
            child: TabBar(
              controller: _tabController,
              labelColor: const Color(0xFF00695C),
              unselectedLabelColor: AppTheme.textSecondary,
              indicatorColor: const Color(0xFF00695C),
              tabs: const [
                Tab(text: 'Add Note'),
                Tab(text: 'Recent Notes'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: const [_AddNoteTab(), _RecentNotesTab()],
            ),
          ),
        ],
      ),
    );
  }
}

class _AddNoteTab extends StatefulWidget {
  const _AddNoteTab();

  @override
  State<_AddNoteTab> createState() => _AddNoteTabState();
}

class _AddNoteTabState extends State<_AddNoteTab> {
  final _formKey = GlobalKey<FormState>();
  final _phoneCtrl = TextEditingController();
  final _noteCtrl = TextEditingController();
  String? _noteType;
  String _priority = 'normal';
  bool _submitting = false;

  static const _noteTypes = [
    'Observation',
    'Medication Note',
    'Post-Procedure',
    'Intake/Output',
    'Patient Complaint',
    'Wound Care',
    'Shift Handover',
    'Emergency Note',
    'Other',
  ];

  static const _priorities = ['low', 'normal', 'high', 'urgent'];

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _submitting = true);
    try {
      final body = {
        'phone': _phoneCtrl.text.trim(),
        'note_type': _noteType!,
        'content': _noteCtrl.text.trim(),
        'priority': _priority,
      };

      if (!ConnectivitySyncService.instance.isOnline) {
        await ConnectivitySyncService.instance.enqueue(
          endpoint: '/emr/notes',
          method: 'POST',
          body: body,
          contextLabel: 'Nursing note for ${_phoneCtrl.text.trim()}',
        );
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Saved offline — will sync when connected'),
              backgroundColor: AppTheme.warningAmber,
            ),
          );
        }
      } else {
        await MedicalApiService.createClinicalNote(body);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Nursing note saved successfully'),
              backgroundColor: AppTheme.successGreen,
            ),
          );
        }
      }

      if (mounted) {
        _formKey.currentState!.reset();
        setState(() {
          _noteType = null;
          _priority = 'normal';
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(e.toString().replaceFirst('Exception: ', '')),
            backgroundColor: AppTheme.errorRed,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header banner
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFF00695C).withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: const Color(0xFF00695C).withValues(alpha: 0.3),
              ),
            ),
            child: const Row(
              children: [
                Icon(Icons.info_outline, color: Color(0xFF00695C), size: 18),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Backend integration coming soon. Notes are previewed locally.',
                    style: TextStyle(color: Color(0xFF00695C), fontSize: 12),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          Form(
            key: _formKey,
            child: Column(
              children: [
                // Patient phone
                TextFormField(
                  controller: _phoneCtrl,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(
                    labelText: 'Patient Phone Number',
                    hintText: '+91 XXXXX XXXXX',
                    prefixIcon: Icon(Icons.phone_outlined),
                  ),
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) {
                      return 'Phone is required';
                    }
                    if (v.trim().length < 10) {
                      return 'Enter valid phone number';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 14),

                // Note type
                DropdownButtonFormField<String>(
                  initialValue: _noteType,
                  decoration: const InputDecoration(
                    labelText: 'Note Type',
                    prefixIcon: Icon(Icons.category_outlined),
                  ),
                  items: _noteTypes
                      .map((t) => DropdownMenuItem(value: t, child: Text(t)))
                      .toList(),
                  onChanged: (v) => setState(() => _noteType = v),
                  validator: (v) => v == null ? 'Select note type' : null,
                ),
                const SizedBox(height: 14),

                // Priority
                const Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'Priority',
                    style: TextStyle(
                      color: AppTheme.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: _priorities.map((p) {
                    final selected = _priority == p;
                    final color = switch (p) {
                      'low' => AppTheme.successGreen,
                      'normal' => AppTheme.primaryBlue,
                      'high' => AppTheme.warningAmber,
                      'urgent' => AppTheme.errorRed,
                      _ => AppTheme.textSecondary,
                    };
                    return Expanded(
                      child: Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: GestureDetector(
                          onTap: () => setState(() => _priority = p),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 150),
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            decoration: BoxDecoration(
                              color: selected
                                  ? color
                                  : color.withValues(alpha: 0.08),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(
                                color: color.withValues(alpha: 0.4),
                              ),
                            ),
                            child: Text(
                              p.toUpperCase(),
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                                color: selected ? Colors.white : color,
                              ),
                            ),
                          ),
                        ),
                      ),
                    );
                  }).toList(),
                ),
                const SizedBox(height: 14),

                // Note text
                TextFormField(
                  controller: _noteCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Clinical Note',
                    hintText:
                        'Describe observations, care provided, patient response...',
                    prefixIcon: Icon(Icons.edit_note_outlined),
                    alignLabelWithHint: true,
                  ),
                  maxLines: 6,
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) {
                      return 'Note is required';
                    }
                    if (v.trim().length < 10) {
                      return 'Note is too short';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 24),

                ElevatedButton.icon(
                  onPressed: _submitting ? null : _submit,
                  icon: _submitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            color: Colors.white,
                            strokeWidth: 2,
                          ),
                        )
                      : const Icon(Icons.save, color: Colors.white),
                  label: Text(_submitting ? 'Saving...' : 'Save Note'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF00695C),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _RecentNotesTab extends StatelessWidget {
  const _RecentNotesTab();

  @override
  Widget build(BuildContext context) {
    // TODO: Fetch recent notes from backend when API is available
    return const Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.edit_note, size: 56, color: AppTheme.textSecondary),
          SizedBox(height: 16),
          Text(
            'Recent Notes',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
              color: AppTheme.textPrimary,
            ),
          ),
          SizedBox(height: 8),
          Padding(
            padding: EdgeInsets.symmetric(horizontal: 40),
            child: Text(
              'Your recent nursing notes will appear here once the backend API is connected.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}
