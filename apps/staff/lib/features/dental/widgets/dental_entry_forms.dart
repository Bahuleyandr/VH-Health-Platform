import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';
import '../models/dental_models.dart';

class DentalFindingEntryForm extends StatefulWidget {
  final String initialTooth;
  final Future<void> Function(DentalFindingDraft draft) onSubmit;

  const DentalFindingEntryForm({
    super.key,
    required this.initialTooth,
    required this.onSubmit,
  });

  @override
  State<DentalFindingEntryForm> createState() => _DentalFindingEntryFormState();
}

class _DentalFindingEntryFormState extends State<DentalFindingEntryForm> {
  late final TextEditingController _toothController;
  final _severityController = TextEditingController();
  final _notesController = TextEditingController();
  String _finding = dentalFindingTypes.first;
  String? _surface;
  bool _saving = false;

  bool get _validTooth => FdiToothLayout.isValid(_toothController.text);

  @override
  void initState() {
    super.initState();
    _toothController = TextEditingController(text: widget.initialTooth);
  }

  @override
  void dispose() {
    _toothController.dispose();
    _severityController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_validTooth || _saving) return;
    setState(() => _saving = true);
    try {
      await widget.onSubmit(
        DentalFindingDraft(
          toothFdi: _toothController.text.trim(),
          surface: _surface,
          finding: _finding,
          severity: _nullIfBlank(_severityController.text),
          notes: _nullIfBlank(_notesController.text),
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          s.lookup('dental.add_finding'),
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 14),
        TextField(
          key: const ValueKey('dental-finding-tooth'),
          controller: _toothController,
          decoration: InputDecoration(
            labelText: s.lookup('dental.tooth'),
            errorText: _validTooth ? null : s.lookup('dental.invalid_tooth'),
          ),
          keyboardType: TextInputType.number,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          key: const ValueKey('dental-finding-type'),
          initialValue: _finding,
          decoration: InputDecoration(labelText: s.lookup('dental.finding')),
          items: [
            for (final type in dentalFindingTypes)
              DropdownMenuItem(value: type, child: Text(dentalLabel(type))),
          ],
          onChanged: (value) {
            if (value != null) setState(() => _finding = value);
          },
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          key: const ValueKey('dental-finding-surface'),
          initialValue: _surface,
          decoration: InputDecoration(labelText: s.lookup('dental.surface')),
          items: [
            DropdownMenuItem<String>(
              value: null,
              child: Text(s.lookup('dental.none')),
            ),
            for (final surface in dentalSurfaces)
              DropdownMenuItem(
                value: surface,
                child: Text(dentalLabel(surface)),
              ),
          ],
          onChanged: (value) => setState(() => _surface = value),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _severityController,
          decoration: InputDecoration(
            labelText: s.lookup('dental.severity'),
            hintText: s.lookup('dental.severity_hint'),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _notesController,
          decoration: InputDecoration(labelText: s.lookup('dental.notes')),
          minLines: 2,
          maxLines: 4,
        ),
        const SizedBox(height: 18),
        FilledButton.icon(
          key: const ValueKey('dental-finding-submit'),
          onPressed: _validTooth && !_saving ? _submit : null,
          icon: _saving
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.save_outlined),
          label: Text(s.lookup('dental.submit_finding')),
        ),
      ],
    );
  }
}

class DentalProcedureEntryForm extends StatefulWidget {
  final String? initialTooth;
  final DentalFinding? linkedFinding;
  final Future<void> Function(DentalProcedureDraft draft) onSubmit;

  const DentalProcedureEntryForm({
    super.key,
    this.initialTooth,
    this.linkedFinding,
    required this.onSubmit,
  });

  @override
  State<DentalProcedureEntryForm> createState() =>
      _DentalProcedureEntryFormState();
}

class _DentalProcedureEntryFormState extends State<DentalProcedureEntryForm> {
  late final TextEditingController _toothController;
  final _nameController = TextEditingController();
  final _codeController = TextEditingController();
  final _anesthesiaController = TextEditingController();
  final _notesController = TextEditingController();
  String? _surface;
  bool _saving = false;

  bool get _validTooth {
    final tooth = _toothController.text.trim();
    return tooth.isEmpty || FdiToothLayout.isValid(tooth);
  }

  bool get _validName => _nameController.text.trim().isNotEmpty;

  @override
  void initState() {
    super.initState();
    final finding = widget.linkedFinding;
    _toothController = TextEditingController(
      text: widget.initialTooth ?? finding?.toothFdi ?? '',
    );
    _surface = finding?.surface;
  }

  @override
  void dispose() {
    _toothController.dispose();
    _nameController.dispose();
    _codeController.dispose();
    _anesthesiaController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_validTooth || !_validName || _saving) return;
    setState(() => _saving = true);
    try {
      await widget.onSubmit(
        DentalProcedureDraft(
          toothFdi: _nullIfBlank(_toothController.text),
          surface: _surface,
          findingId: widget.linkedFinding?.id,
          procedureName: _nameController.text.trim(),
          procedureCode: _nullIfBlank(_codeController.text),
          anesthesia: _nullIfBlank(_anesthesiaController.text),
          notes: _nullIfBlank(_notesController.text),
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          s.lookup('dental.plan_procedure'),
          style: Theme.of(context).textTheme.titleLarge,
        ),
        if (widget.linkedFinding != null) ...[
          const SizedBox(height: 8),
          Text(
            s.format('dental.linked_finding_value', {
              'finding': dentalLabel(widget.linkedFinding!.finding),
              'tooth': widget.linkedFinding!.toothFdi,
            }),
          ),
        ],
        const SizedBox(height: 14),
        TextField(
          controller: _toothController,
          decoration: InputDecoration(
            labelText: s.lookup('dental.tooth_optional'),
            errorText: _validTooth ? null : s.lookup('dental.invalid_tooth'),
          ),
          keyboardType: TextInputType.number,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          initialValue: _surface,
          decoration: InputDecoration(labelText: s.lookup('dental.surface')),
          items: [
            DropdownMenuItem<String>(
              value: null,
              child: Text(s.lookup('dental.none')),
            ),
            for (final surface in dentalSurfaces)
              DropdownMenuItem(
                value: surface,
                child: Text(dentalLabel(surface)),
              ),
          ],
          onChanged: (value) => setState(() => _surface = value),
        ),
        const SizedBox(height: 12),
        TextField(
          key: const ValueKey('dental-procedure-name'),
          controller: _nameController,
          decoration: InputDecoration(
            labelText: s.lookup('dental.procedure_name'),
          ),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _codeController,
          decoration: InputDecoration(
            labelText: s.lookup('dental.procedure_code'),
            hintText: s.lookup('dental.procedure_code_hint'),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _anesthesiaController,
          decoration: InputDecoration(labelText: s.lookup('dental.anesthesia')),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _notesController,
          decoration: InputDecoration(labelText: s.lookup('dental.notes')),
          minLines: 2,
          maxLines: 4,
        ),
        const SizedBox(height: 18),
        FilledButton.icon(
          key: const ValueKey('dental-procedure-submit'),
          onPressed: _validTooth && _validName && !_saving ? _submit : null,
          icon: _saving
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.add_task_outlined),
          label: Text(s.lookup('dental.submit_procedure')),
        ),
      ],
    );
  }
}

String? _nullIfBlank(String value) {
  final text = value.trim();
  return text.isEmpty ? null : text;
}
