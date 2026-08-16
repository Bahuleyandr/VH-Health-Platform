import 'dart:async';

import 'package:flutter/material.dart';

import '../services/medical_api_service.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

class CodedDiagnosisPicker extends StatefulWidget {
  final TextEditingController controller;
  final String label;
  final String hint;
  final bool enabled;
  final int minLines;
  final Map<String, dynamic>? selectedCoding;
  final ValueChanged<Map<String, dynamic>?> onCodingChanged;
  final Widget? suffixAction;
  final FocusNode? focusNode;

  const CodedDiagnosisPicker({
    super.key,
    required this.controller,
    required this.label,
    required this.hint,
    required this.onCodingChanged,
    this.enabled = true,
    this.minLines = 2,
    this.selectedCoding,
    this.suffixAction,
    this.focusNode,
  });

  @override
  State<CodedDiagnosisPicker> createState() => _CodedDiagnosisPickerState();
}

class _CodedDiagnosisPickerState extends State<CodedDiagnosisPicker> {
  late final FocusNode _ownedFocusNode;
  Timer? _debounce;
  bool _loading = false;
  List<Map<String, dynamic>> _suggestions = const [];

  FocusNode get _focusNode => widget.focusNode ?? _ownedFocusNode;

  @override
  void initState() {
    super.initState();
    _ownedFocusNode = FocusNode();
    widget.controller.addListener(_queueSearch);
    _focusNode.addListener(_queueSearch);
  }

  @override
  void didUpdateWidget(covariant CodedDiagnosisPicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.focusNode != widget.focusNode) {
      (oldWidget.focusNode ?? _ownedFocusNode).removeListener(_queueSearch);
      _focusNode.addListener(_queueSearch);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_queueSearch);
    _debounce?.cancel();
    _focusNode.removeListener(_queueSearch);
    _ownedFocusNode.dispose();
    super.dispose();
  }

  void _queueSearch() {
    _debounce?.cancel();
    if (!widget.enabled || !_focusNode.hasFocus) return;
    final query = widget.controller.text.trim();
    if (query.length < 2) {
      if (mounted && _suggestions.isNotEmpty) {
        setState(() => _suggestions = const []);
      }
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 350), () {
      _search(query);
    });
  }

  Future<void> _search(String query) async {
    if (!mounted) return;
    setState(() => _loading = true);
    try {
      final res = await MedicalApiService.searchTerminology(
        system: 'ICD11',
        query: query,
        limit: 12,
      );
      final raw = res['concepts'] ?? res['data'];
      final suggestions = raw is List
          ? raw
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .where((item) => (item['code'] ?? '').toString().isNotEmpty)
                .toList()
          : <Map<String, dynamic>>[];
      if (!mounted) return;
      setState(() {
        _suggestions = suggestions;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _suggestions = const [];
        _loading = false;
      });
    }
  }

  Map<String, dynamic> _codingPayload(Map<String, dynamic> item) {
    return {
      'system': 'ICD11',
      'system_key': 'ICD11',
      'code': item['code']?.toString(),
      'display': item['display']?.toString(),
      if (item['release_id'] != null) 'release_id': item['release_id'],
      if (item['language'] != null) 'language': item['language'],
      if (item['linearization_uri'] != null)
        'linearization_uri': item['linearization_uri'],
      if (item['foundation_uri'] != null)
        'foundation_uri': item['foundation_uri'],
    }..removeWhere((_, value) => value == null || value == '');
  }

  void _select(Map<String, dynamic> item) {
    final display = (item['display'] ?? item['code'] ?? '').toString().trim();
    widget.controller.value = TextEditingValue(
      text: display,
      selection: TextSelection.collapsed(offset: display.length),
    );
    widget.onCodingChanged(_codingPayload(item));
    setState(() => _suggestions = const []);
  }

  @override
  Widget build(BuildContext context) {
    final selected = widget.selectedCoding;
    final selectedCode = (selected?['code'] ?? '').toString();
    final selectedSystem =
        (selected?['system_key'] ?? selected?['system'] ?? 'ICD11').toString();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: widget.controller,
          focusNode: _focusNode,
          minLines: widget.minLines,
          maxLines: widget.minLines + 4,
          enabled: widget.enabled,
          textCapitalization: TextCapitalization.sentences,
          decoration: InputDecoration(
            labelText: widget.label,
            hintText: widget.hint,
            alignLabelWithHint: true,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
            suffixIcon: _loading
                ? const Padding(
                    padding: EdgeInsets.all(14),
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (widget.suffixAction != null) widget.suffixAction!,
                      IconButton(
                        tooltip: AppStrings.of(
                          context,
                        ).lookup('s4.lib.coded_diagnosis_picker.search_icd_11'),
                        icon: const Icon(Icons.search),
                        onPressed: widget.enabled
                            ? () => _search(widget.controller.text.trim())
                            : null,
                      ),
                    ],
                  ),
          ),
        ),
        if (selectedCode.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: InputChip(
              avatar: const Icon(Icons.medical_information_outlined, size: 18),
              label: Text('$selectedSystem $selectedCode'),
              onDeleted: widget.enabled
                  ? () => widget.onCodingChanged(null)
                  : null,
            ),
          ),
        if (_suggestions.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Material(
              elevation: 3,
              borderRadius: BorderRadius.circular(8),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 240),
                child: ListView.separated(
                  shrinkWrap: true,
                  padding: EdgeInsets.zero,
                  itemBuilder: (context, index) {
                    final item = _suggestions[index];
                    final code = (item['code'] ?? '').toString();
                    final display = (item['display'] ?? '').toString();
                    return ListTile(
                      dense: true,
                      title: Text(display.isEmpty ? code : display),
                      subtitle: code.isEmpty ? null : Text('ICD-11 $code'),
                      onTap: () => _select(item),
                    );
                  },
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemCount: _suggestions.length,
                ),
              ),
            ),
          ),
      ],
    );
  }
}
