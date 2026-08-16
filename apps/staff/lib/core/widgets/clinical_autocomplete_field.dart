import 'package:flutter/material.dart';

const List<String> kClinicalAutocompletePhrases = [
  'chest pain',
  'abdominal pain',
  'breathlessness',
  'palpitation',
  'sweating',
  'nausea',
  'vomiting',
  'fever',
  'cough',
  'giddiness',
  'headache',
  'loose stools',
  'burning micturition',
  'decreased urine output',
  'pedal edema',
  'type 2 diabetes mellitus',
  'systemic hypertension',
  'dyslipidemia',
  'coronary artery disease',
  'bronchial asthma',
  'chronic kidney disease',
  'no known drug allergy',
  'amoxicillin allergy',
  'conscious and oriented',
  'S1 S2 heard',
  'bilateral air entry present',
  'soft, bowel sounds heard',
  'no focal neurological deficit',
  'post-operative monitoring',
  'provisional diagnosis',
  'review with reports',
];

class ClinicalAutocompleteField extends StatefulWidget {
  final TextEditingController controller;
  final String label;
  final String? hint;
  final int minLines;
  final int maxLines;

  const ClinicalAutocompleteField({
    super.key,
    required this.controller,
    required this.label,
    this.hint,
    this.minLines = 1,
    this.maxLines = 4,
  });

  @override
  State<ClinicalAutocompleteField> createState() =>
      _ClinicalAutocompleteFieldState();
}

class _ClinicalAutocompleteFieldState extends State<ClinicalAutocompleteField> {
  final FocusNode _focusNode = FocusNode();
  String _lastText = '';
  String? _previewSuggestion;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_updatePreviewSuggestion);
    _focusNode.addListener(_updatePreviewSuggestion);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_updatePreviewSuggestion);
    _focusNode.dispose();
    super.dispose();
  }

  String _tail(String text) {
    final parts = text.split(RegExp(r'[\n,.;:]'));
    return parts.isEmpty ? text : parts.last.trimLeft();
  }

  TextEditingValue _replaceTail(String original, String suggestion) {
    final match = RegExp(r'[\n,.;:][^,\n.;:]*$').firstMatch(original);
    final start = match == null ? 0 : match.start + 1;
    final prefix = original.substring(0, start);
    final separatorSpace =
        prefix.isNotEmpty && !prefix.endsWith(' ') && !prefix.endsWith('\n')
        ? ' '
        : '';
    final next = '$prefix$separatorSpace$suggestion';
    return TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: next.length),
    );
  }

  void _updatePreviewSuggestion() {
    final query = _tail(widget.controller.text).toLowerCase();
    String? next;
    if (query.length >= 2 && _focusNode.hasFocus) {
      for (final phrase in kClinicalAutocompletePhrases) {
        if (phrase.toLowerCase().startsWith(query)) {
          next = phrase;
          break;
        }
      }
    }
    if (next == _previewSuggestion || !mounted) return;
    setState(() => _previewSuggestion = next);
  }

  @override
  Widget build(BuildContext context) {
    return RawAutocomplete<String>(
      textEditingController: widget.controller,
      focusNode: _focusNode,
      optionsBuilder: (value) {
        _lastText = value.text;
        final query = _tail(value.text).toLowerCase();
        if (query.length < 2) return const Iterable<String>.empty();
        return kClinicalAutocompletePhrases
            .where((phrase) => phrase.toLowerCase().startsWith(query))
            .take(8);
      },
      onSelected: (suggestion) {
        widget.controller.value = _replaceTail(_lastText, suggestion);
      },
      fieldViewBuilder: (context, controller, focusNode, onFieldSubmitted) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: controller,
              focusNode: focusNode,
              minLines: widget.minLines,
              maxLines: widget.maxLines,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                labelText: widget.label,
                hintText: widget.hint,
                border: const OutlineInputBorder(),
                alignLabelWithHint: widget.maxLines > 1,
              ),
            ),
            if (_previewSuggestion != null)
              Padding(
                padding: const EdgeInsets.only(left: 12, top: 4),
                child: Text(
                  _previewSuggestion!,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant
                        .withValues(alpha: 0.68),
                  ),
                ),
              ),
          ],
        );
      },
      optionsViewBuilder: (context, onSelected, options) {
        return Align(
          alignment: Alignment.topLeft,
          child: Material(
            elevation: 4,
            borderRadius: BorderRadius.circular(8),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420, maxHeight: 240),
              child: ListView.builder(
                padding: EdgeInsets.zero,
                shrinkWrap: true,
                itemCount: options.length,
                itemBuilder: (context, index) {
                  final option = options.elementAt(index);
                  return ListTile(
                    dense: true,
                    title: Text(option),
                    onTap: () => onSelected(option),
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }
}
