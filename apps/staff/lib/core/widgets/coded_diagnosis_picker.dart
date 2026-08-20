import 'dart:async';

import 'package:flutter/material.dart';

import '../services/medical_api_service.dart';

import 'package:vhhealth_staff/l10n/app_strings.dart';

/// Search callback contract (mirrors MedicalApiService.searchTerminology).
/// [system] null means settings-driven multi-system search on the backend.
typedef TerminologySearchFn =
    Future<Map<String, dynamic>> Function({
      String? system,
      required String query,
      int limit,
    });

/// Settings callback contract (mirrors MedicalApiService.getTerminologySettings).
typedef TerminologySettingsFn = Future<Map<String, dynamic>> Function();

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

  /// Test seams — default to the shared MedicalApiService implementations.
  final TerminologySearchFn? searchTerminology;
  final TerminologySettingsFn? loadTerminologySettings;

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
    this.searchTerminology,
    this.loadTerminologySettings,
  });

  @override
  State<CodedDiagnosisPicker> createState() => _CodedDiagnosisPickerState();
}

class _CodedDiagnosisPickerState extends State<CodedDiagnosisPicker> {
  late final FocusNode _ownedFocusNode;
  Timer? _debounce;
  bool _loading = false;
  List<Map<String, dynamic>> _suggestions = const [];

  // Settings-driven system resolution. Defaults reproduce the historical
  // hardcoded ICD-11 behavior exactly; only a tenant that has changed its
  // terminology settings (preferred system / SNOMED pickers) sees anything
  // different.
  String _preferredSystem = 'ICD11';
  bool _multiSystem = false;

  FocusNode get _focusNode => widget.focusNode ?? _ownedFocusNode;

  TerminologySearchFn get _searchFn {
    final override = widget.searchTerminology;
    if (override != null) return override;
    return ({String? system, required String query, int limit = 20}) {
      return MedicalApiService.searchTerminology(
        system: system,
        query: query,
        limit: limit,
      );
    };
  }

  TerminologySettingsFn get _settingsFn {
    final override = widget.loadTerminologySettings;
    if (override != null) return override;
    return () => MedicalApiService.getTerminologySettings();
  }

  @override
  void initState() {
    super.initState();
    _ownedFocusNode = FocusNode();
    widget.controller.addListener(_queueSearch);
    _focusNode.addListener(_queueSearch);
    _loadSettings();
  }

  Future<void> _loadSettings() async {
    try {
      final settings = await _settingsFn();
      if (!mounted) return;
      final preferred = _normalizeSystem(
        settings['preferred_diagnosis_system'],
      );
      setState(() {
        _preferredSystem = preferred ?? 'ICD11';
        // The dark multi-system flag: only when the tenant has explicitly
        // enabled SNOMED pickers does the picker defer system choice to the
        // backend's settings-driven search.
        _multiSystem = settings['snomed_pickers_enabled'] == true;
      });
    } catch (_) {
      // Settings unavailable — keep the byte-identical ICD-11 defaults.
    }
  }

  String? _normalizeSystem(dynamic value) {
    if (value == null) return null;
    final text = value.toString().trim().toUpperCase().replaceAll('-', '_');
    const known = {'ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC'};
    if (known.contains(text)) return text;
    if (text == 'ICD_10') return 'ICD10';
    if (text == 'ICD_11') return 'ICD11';
    if (text == 'SNOMED' || text == 'SCT') return 'SNOMED_CT';
    return null;
  }

  String _systemLabel(String key) {
    switch (key) {
      case 'ICD11':
        return 'ICD-11';
      case 'ICD10':
        return 'ICD-10';
      case 'SNOMED_CT':
        return 'SNOMED CT';
      default:
        return key;
    }
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
      final res = await _searchFn(
        // Multi-system mode (snomed_pickers_enabled): omit the system so the
        // backend groups/ranks across the tenant's enabled systems. Single-
        // system mode keeps the explicit-system legacy contract.
        system: _multiSystem ? null : _preferredSystem,
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

  String _systemKeyOf(Map<String, dynamic> item) {
    final key = _normalizeSystem(item['system_key'] ?? item['system']);
    return key ?? _preferredSystem;
  }

  Map<String, dynamic> _codingPayload(Map<String, dynamic> item) {
    final systemKey = _systemKeyOf(item);
    return {
      'system': systemKey,
      'system_key': systemKey,
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
        (selected?['system_key'] ?? selected?['system'] ?? _preferredSystem)
            .toString();
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
                    final systemLabel = _systemLabel(_systemKeyOf(item));
                    return ListTile(
                      dense: true,
                      title: Text(display.isEmpty ? code : display),
                      subtitle: code.isEmpty ? null : Text('$systemLabel $code'),
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
