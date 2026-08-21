import 'dart:convert';

import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';
import '../models/cath_report_models.dart';

class CathReportEditor extends StatefulWidget {
  const CathReportEditor({
    super.key,
    required this.templates,
    required this.onSave,
    this.report,
  });

  final List<CathReportTemplate> templates;
  final CathProcedureReport? report;
  final Future<void> Function(CathReportDraft draft) onSave;

  @override
  State<CathReportEditor> createState() => _CathReportEditorState();
}

class _CathReportEditorState extends State<CathReportEditor> {
  final _formKey = GlobalKey<FormState>();
  final _narrativeControllers = <String, TextEditingController>{};
  final _fieldControllers = <String, TextEditingController>{};
  final _booleanValues = <String, bool>{};
  final _selectedValues = <String, String?>{};
  final _multiSelectedValues = <String, Set<String>>{};

  late final List<CathReportTemplate> _templates;
  CathReportTemplate? _selectedTemplate;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _templates = [...widget.templates];
    final report = widget.report;
    CathReportTemplate? selected;
    if (report != null) {
      for (final template in _templates) {
        if (report.templateId != null && template.id == report.templateId) {
          selected = template;
          break;
        }
      }
      if (selected == null) {
        selected = CathReportTemplate.forReport(report);
        _templates.add(selected);
      }
    } else if (_templates.isNotEmpty) {
      selected = _templates.first;
    }
    _configureTemplate(selected, report: report);
  }

  @override
  void dispose() {
    _disposeControllers();
    super.dispose();
  }

  void _disposeControllers() {
    for (final controller in _narrativeControllers.values) {
      controller.dispose();
    }
    for (final controller in _fieldControllers.values) {
      controller.dispose();
    }
    _narrativeControllers.clear();
    _fieldControllers.clear();
  }

  void _configureTemplate(
    CathReportTemplate? template, {
    CathProcedureReport? report,
  }) {
    _disposeControllers();
    _booleanValues.clear();
    _selectedValues.clear();
    _multiSelectedValues.clear();
    _selectedTemplate = template;
    if (template == null) return;

    for (final section in template.sections) {
      _narrativeControllers[section.key] = TextEditingController(
        text: report?.narrativeSections[section.key] ?? '',
      );
    }
    for (final field in template.codedFields) {
      final initial = report?.codedFields[field.key];
      if (field.isBoolean) {
        _booleanValues[field.key] = initial == true || '$initial' == 'true';
      } else if (field.options.isNotEmpty && field.isArray) {
        final values = initial is List
            ? initial.map((value) => '$value').toSet()
            : <String>{};
        _multiSelectedValues[field.key] = values;
      } else if (field.options.isNotEmpty) {
        final value = initial?.toString();
        _selectedValues[field.key] = field.options.contains(value)
            ? value
            : null;
      } else {
        final text = field.isObject || field.isArrayOfObjects
            ? initial == null
                  ? ''
                  : const JsonEncoder.withIndent('  ').convert(initial)
            : initial is List
            ? initial.map((value) => '$value').join(', ')
            : initial?.toString() ?? '';
        _fieldControllers[field.key] = TextEditingController(text: text);
      }
    }
  }

  void _selectTemplate(int? templateId) {
    if (templateId == null) return;
    final selected = _templates.firstWhere(
      (template) => template.id == templateId,
      orElse: () => _templates.first,
    );
    setState(() => _configureTemplate(selected));
  }

  Future<void> _save() async {
    final template = _selectedTemplate;
    if (template == null || _saving) return;
    if (_formKey.currentState?.validate() != true) return;
    setState(() => _saving = true);
    try {
      final codedFields = <String, dynamic>{};
      for (final field in template.codedFields) {
        if (field.isBoolean) {
          codedFields[field.key] = _booleanValues[field.key] ?? false;
          continue;
        }
        if (field.options.isNotEmpty && field.isArray) {
          final selected = _multiSelectedValues[field.key] ?? const <String>{};
          if (selected.isNotEmpty || field.required) {
            codedFields[field.key] = selected.toList(growable: false);
          }
          continue;
        }
        if (field.options.isNotEmpty) {
          final selected = _selectedValues[field.key];
          if (selected != null && selected.isNotEmpty) {
            codedFields[field.key] = selected;
          }
          continue;
        }
        final raw = _fieldControllers[field.key]?.text.trim() ?? '';
        if (raw.isEmpty && !field.required) continue;
        if (field.isObject || field.isArrayOfObjects) {
          codedFields[field.key] = jsonDecode(raw);
        } else if (field.isNumber) {
          final parsed = num.tryParse(raw);
          codedFields[field.key] = field.isInteger ? parsed?.toInt() : parsed;
        } else if (field.isArray) {
          codedFields[field.key] = raw
              .split(',')
              .map((value) => value.trim())
              .where((value) => value.isNotEmpty)
              .toList(growable: false);
        } else {
          codedFields[field.key] = raw;
        }
      }

      await widget.onSave(
        CathReportDraft(
          templateId: template.id,
          reportType: template.reportType,
          procedureLogId: widget.report?.procedureLogId,
          narrativeSections: _narrativeControllers.map(
            (key, controller) => MapEntry(key, controller.text.trim()),
          ),
          narrativeSectionTitles: {
            for (final section in template.sections) section.key: section.title,
          },
          codedFields: codedFields,
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String? _requiredTextValidator(String label, String? value) {
    if ((value ?? '').trim().isNotEmpty) return null;
    return AppStrings.of(context)
        .format('s4.dynamic.cath_lab.report.required', {'label': label});
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStrings.of(context);
    final template = _selectedTemplate;
    if (template == null) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Text(s.lookup('s4.lib.cath_lab.report.template_unavailable')),
      );
    }

    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
        children: [
          Text(
            widget.report == null
                ? s.lookup('s4.lib.cath_lab.report.create')
                : s.lookup('s4.lib.cath_lab.report.edit'),
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<int>(
            key: const ValueKey('cath-report-template'),
            initialValue: template.id,
            decoration: InputDecoration(
              labelText: s.lookup('s4.lib.cath_lab.report.template'),
            ),
            items: [
              for (final item in _templates)
                DropdownMenuItem(value: item.id, child: Text(item.name)),
            ],
            onChanged: widget.report == null ? _selectTemplate : null,
          ),
          const SizedBox(height: 20),
          _SectionHeading(
            icon: Icons.notes_outlined,
            label: s.lookup('s4.lib.cath_lab.report.narrative_sections'),
          ),
          const SizedBox(height: 10),
          for (final section in template.sections) ...[
            TextFormField(
              key: ValueKey('cath-report-section-${section.key}'),
              controller: _narrativeControllers[section.key],
              minLines: section.multiline ? 3 : 1,
              maxLines: section.multiline ? 7 : 1,
              decoration: InputDecoration(
                labelText: section.title,
                alignLabelWithHint: section.multiline,
              ),
              validator: section.required
                  ? (value) => _requiredTextValidator(section.title, value)
                  : null,
            ),
            const SizedBox(height: 12),
          ],
          if (template.codedFields.isNotEmpty) ...[
            const SizedBox(height: 8),
            _SectionHeading(
              icon: Icons.dataset_outlined,
              label: s.lookup('s4.lib.cath_lab.report.coded_fields'),
            ),
            const SizedBox(height: 10),
            for (final field in template.codedFields) ...[
              _buildCodedField(field),
              const SizedBox(height: 12),
            ],
          ],
          const SizedBox(height: 8),
          FilledButton.icon(
            key: const ValueKey('cath-report-save'),
            onPressed: _saving ? null : _save,
            icon: _saving
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save_outlined),
            label: Text(
              _saving
                  ? s.lookup('s4.lib.cath_lab.report.saving')
                  : s.lookup('s4.lib.cath_lab.report.save_draft'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCodedField(CathReportFieldDefinition field) {
    final s = AppStrings.of(context);
    final label = field.unit.isEmpty
        ? field.title
        : '${field.title} (${field.unit})';
    if (field.isBoolean) {
      return SwitchListTile.adaptive(
        key: ValueKey('cath-report-coded-${field.key}'),
        contentPadding: EdgeInsets.zero,
        title: Text(label),
        subtitle: field.description.isEmpty ? null : Text(field.description),
        value: _booleanValues[field.key] ?? false,
        onChanged: (value) {
          setState(() => _booleanValues[field.key] = value);
        },
      );
    }
    if (field.options.isNotEmpty && field.isArray) {
      final selected = _multiSelectedValues[field.key] ?? <String>{};
      return FormField<Set<String>>(
        key: ValueKey('cath-report-coded-${field.key}'),
        initialValue: selected,
        validator: (value) {
          if (!field.required || (value?.isNotEmpty ?? false)) return null;
          return s.format('s4.dynamic.cath_lab.report.required', {
            'label': label,
          });
        },
        builder: (state) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: Theme.of(context).textTheme.titleSmall),
            if (field.description.isNotEmpty) Text(field.description),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              children: [
                for (final option in field.options)
                  FilterChip(
                    label: Text(_humanize(option)),
                    selected: selected.contains(option),
                    onSelected: (isSelected) {
                      setState(() {
                        if (isSelected) {
                          selected.add(option);
                        } else {
                          selected.remove(option);
                        }
                      });
                      state.didChange(selected);
                    },
                  ),
              ],
            ),
            if (state.hasError)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  state.errorText!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      );
    }
    if (field.options.isNotEmpty) {
      return DropdownButtonFormField<String>(
        key: ValueKey('cath-report-coded-${field.key}'),
        initialValue: _selectedValues[field.key],
        decoration: InputDecoration(
          labelText: label,
          helperText: field.description.isEmpty ? null : field.description,
        ),
        items: [
          for (final option in field.options)
            DropdownMenuItem(value: option, child: Text(_humanize(option))),
        ],
        onChanged: (value) => _selectedValues[field.key] = value,
        validator: field.required
            ? (value) => _requiredTextValidator(label, value)
            : null,
      );
    }
    return TextFormField(
      key: ValueKey('cath-report-coded-${field.key}'),
      controller: _fieldControllers[field.key],
      keyboardType: field.isNumber
          ? const TextInputType.numberWithOptions(decimal: true)
          : TextInputType.text,
      minLines: field.isArray || field.isObject ? 2 : 1,
      maxLines: field.isArray || field.isObject ? 8 : 1,
      decoration: InputDecoration(
        labelText: label,
        helperText: field.description.isEmpty ? null : field.description,
      ),
      validator: (value) {
        if (field.required) {
          final requiredError = _requiredTextValidator(label, value);
          if (requiredError != null) return requiredError;
        }
        if (field.isNumber && (value ?? '').trim().isNotEmpty) {
          if (num.tryParse(value!.trim()) == null) {
            return s.format('s4.dynamic.cath_lab.report.invalid_number', {
              'label': label,
            });
          }
        }
        if ((field.isObject || field.isArrayOfObjects) &&
            (value ?? '').trim().isNotEmpty) {
          try {
            final parsed = jsonDecode(value!);
            final validType = field.isObject ? parsed is Map : parsed is List;
            if (!validType) {
              return s.format('s4.dynamic.cath_lab.report.invalid_json', {
                'label': label,
              });
            }
          } catch (_) {
            return s.format('s4.dynamic.cath_lab.report.invalid_json', {
              'label': label,
            });
          }
        }
        return null;
      },
    );
  }
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 20, color: Theme.of(context).colorScheme.primary),
        const SizedBox(width: 8),
        Text(label, style: Theme.of(context).textTheme.titleMedium),
      ],
    );
  }
}

String _humanize(String value) {
  final words = value
      .replaceAll(RegExp(r'[_-]+'), ' ')
      .trim()
      .split(RegExp(r'\s+'))
      .where((word) => word.isNotEmpty)
      .map((word) => '${word[0].toUpperCase()}${word.substring(1)}')
      .join(' ');
  return words.isEmpty ? value : words;
}
