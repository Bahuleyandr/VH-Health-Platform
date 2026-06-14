import 'package:flutter/material.dart';

import '../../../l10n/app_strings.dart';

/// Override categories for a CDS allergy/interaction blocker.
enum _CdsOverrideCategory {
  priorToleranceDocumented(
    'prior-tolerance-documented',
    'Prior tolerance documented',
  ),
  benefitOutweighsRisk('benefit-outweighs-risk', 'Benefit outweighs risk'),
  alternativeUnavailable('alternative-unavailable', 'No suitable alternative'),
  allergyDisputed('allergy-disputed', 'Allergy disputed / mislabelled'),
  other('other', 'Other (specify below)');

  const _CdsOverrideCategory(this.value, this.label);
  final String value;
  final String label;
}

/// Returns true if [text] is a meaningful clinical justification:
/// - trimmed length >= 15
/// - not composed of a single repeated character (ASCII-range check)
bool _isMeaningfulJustification(String text) {
  final t = text.trim();
  if (t.length < 15) return false;
  if (t.isNotEmpty && t.codeUnits.every((u) => u == t.codeUnitAt(0))) {
    return false;
  }
  return true;
}

/// Outcome of the CDS hard-block modal. If [overrideReason] is non-null, the
/// clinician has chosen to proceed with a recorded override. Otherwise the
/// prescription save is cancelled.
///
/// The [overrideReason] string is structured as:
///   "[category-value] justification | supervisor: name-or-id"
/// for SEVERE allergy blockers (the supervisor field is mandatory there).
/// This format is parseable by the audit system while remaining backward-
/// compatible with the single-string `override.reason` backend field.
class CdsOverrideOutcome {
  CdsOverrideOutcome({this.overrideReason});
  final String? overrideReason;

  /// shouldProceed is true only when the structured fields have been fully
  /// validated — the reason string carries evidence of that validation.
  bool get shouldProceed =>
      overrideReason != null && overrideReason!.trim().length >= 15;
}

/// Blocking modal listing CDS blockers (e.g. SEVERE allergy conflicts). The
/// clinician can cancel or type a required override reason. Allergy blockers
/// ask for a supervisor reference in the reason text — enforcement is social,
/// recorded in the audit row for compliance review.
class CdsBlockerModal extends StatefulWidget {
  const CdsBlockerModal({
    super.key,
    required this.blockers,
    required this.warnings,
    this.allowOverride = true,
  });

  final List<dynamic> blockers;
  final List<dynamic> warnings;

  /// The prescription save path accepts an `override.reason`; the CPOE
  /// order endpoints have no override parameter — their blockers are
  /// final server-side. Pass `false` there so the modal offers only
  /// "adjust the order" instead of a recorded override that the server
  /// would reject anyway.
  final bool allowOverride;

  static Future<CdsOverrideOutcome?> show(
    BuildContext context, {
    required List<dynamic> blockers,
    required List<dynamic> warnings,
    bool allowOverride = true,
  }) {
    return showDialog<CdsOverrideOutcome>(
      context: context,
      barrierDismissible: false,
      builder: (_) => CdsBlockerModal(
        blockers: blockers,
        warnings: warnings,
        allowOverride: allowOverride,
      ),
    );
  }

  @override
  State<CdsBlockerModal> createState() => _CdsBlockerModalState();
}

class _CdsBlockerModalState extends State<CdsBlockerModal> {
  bool _showOverrideField = false;
  _CdsOverrideCategory? _category;
  final TextEditingController _justificationCtrl = TextEditingController();
  // Mandatory for SEVERE allergy blockers — supervisor name/ID reference.
  final TextEditingController _supervisorCtrl = TextEditingController();

  @override
  void dispose() {
    _justificationCtrl.dispose();
    _supervisorCtrl.dispose();
    super.dispose();
  }

  bool _hasSevereAllergyBlocker(List<dynamic> blockers) => blockers.any(
    (b) =>
        b is Map &&
        b['type'] == 'ALLERGY_CONFLICT' &&
        (b['severity'] == 'SEVERE' ||
            b['severity'] == 'severe' ||
            // Some CDS payloads use `level` instead of `severity`
            b['level'] == 'SEVERE' ||
            b['level'] == 'severe'),
  );

  bool get _hasAllergyBlocker =>
      widget.blockers.any((b) => b is Map && b['type'] == 'ALLERGY_CONFLICT');

  bool get _requiresSupervisor => _hasSevereAllergyBlocker(widget.blockers);

  bool get _overrideValid {
    if (_category == null) return false;
    if (!_isMeaningfulJustification(_justificationCtrl.text)) return false;
    if (_category == _CdsOverrideCategory.other &&
        _justificationCtrl.text.trim().isEmpty) {
      return false;
    }
    if (_requiresSupervisor && _supervisorCtrl.text.trim().length < 3) {
      return false;
    }
    return true;
  }

  /// Builds the structured override reason string that is sent to the backend
  /// via `override: { reason: <this> }`. Format is designed to be parseable
  /// by audit tooling without requiring a backend schema change:
  ///   "[category-value] justification | supervisor: name/id"
  String get _overridePayload {
    final cat = _category!.value;
    final just = _justificationCtrl.text.trim();
    final sup = _supervisorCtrl.text.trim();
    final base = '[$cat] $just';
    return sup.isNotEmpty ? '$base | supervisor: $sup' : base;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = AppStrings.of(context);

    return AlertDialog(
      title: Row(
        children: [
          const Icon(Icons.block, color: Colors.red, size: 28),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              s.cdsBlockerTitle,
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(s.cdsBlockerBody, style: theme.textTheme.bodySmall),
            const SizedBox(height: 12),
            ...widget.blockers.map((b) => _issueTile(b, isBlocker: true)),
            if (widget.warnings.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                s.cdsBlockerWarningsHeader,
                style: theme.textTheme.labelMedium?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              ...widget.warnings.map((w) => _issueTile(w, isBlocker: false)),
            ],
            if (!widget.allowOverride) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: Colors.red.withValues(alpha: 0.08),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: Colors.red.withValues(alpha: 0.4)),
                ),
                child: Text(
                  s.cdsBlockerNoOverrideHint,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
            if (_showOverrideField) ...[
              const SizedBox(height: 12),
              if (_hasAllergyBlocker) ...[
                Container(
                  padding: const EdgeInsets.all(8),
                  margin: const EdgeInsets.only(bottom: 8),
                  decoration: BoxDecoration(
                    color: Colors.orange.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                      color: Colors.orange.withValues(alpha: 0.5),
                    ),
                  ),
                  child: Text(
                    s.cdsBlockerAllergyHint,
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
              ],
              // ── Step 1: Category ────────────────────────────────────────
              DropdownButtonFormField<_CdsOverrideCategory>(
                decoration: const InputDecoration(
                  labelText: 'Override category *',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
                initialValue: _category,
                hint: const Text('Select a reason category'),
                items: _CdsOverrideCategory.values
                    .map(
                      (c) => DropdownMenuItem(value: c, child: Text(c.label)),
                    )
                    .toList(),
                onChanged: (v) => setState(() => _category = v),
              ),
              const SizedBox(height: 10),
              // ── Step 2: Clinical justification ──────────────────────────
              TextField(
                controller: _justificationCtrl,
                maxLines: 3,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: 'Clinical justification *',
                  hintText:
                      'Min 15 characters — describe the specific rationale',
                  border: const OutlineInputBorder(),
                  suffixIcon: _justificationCtrl.text.isEmpty
                      ? null
                      : Icon(
                          _isMeaningfulJustification(_justificationCtrl.text)
                              ? Icons.check_circle_outline
                              : Icons.error_outline,
                          color:
                              _isMeaningfulJustification(
                                _justificationCtrl.text,
                              )
                              ? Colors.green
                              : Colors.red,
                          size: 18,
                        ),
                ),
                onChanged: (_) => setState(() {}),
              ),
              if (_justificationCtrl.text.trim().isNotEmpty &&
                  !_isMeaningfulJustification(_justificationCtrl.text)) ...[
                const SizedBox(height: 4),
                Text(
                  _justificationCtrl.text.trim().length < 15
                      ? 'Minimum 15 characters required'
                      : 'Justification must not be a repeated character',
                  style: const TextStyle(fontSize: 11, color: Colors.red),
                ),
              ],
              // ── Step 3 (SEVERE allergy only): Supervisor reference ──────
              if (_requiresSupervisor) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.red.withValues(alpha: 0.06),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                      color: Colors.red.withValues(alpha: 0.4),
                    ),
                  ),
                  child: const Text(
                    'SEVERE allergy conflict: a supervising clinician '
                    'acknowledgement is required.',
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                  ),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _supervisorCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Supervising clinician name / staff ID *',
                    hintText: 'e.g. Dr. Sharma — EMP-1042',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                  onChanged: (_) => setState(() {}),
                ),
                if (_supervisorCtrl.text.isNotEmpty &&
                    _supervisorCtrl.text.trim().length < 3) ...[
                  const SizedBox(height: 4),
                  const Text(
                    'Enter the supervising clinician name or staff ID',
                    style: TextStyle(fontSize: 11, color: Colors.red),
                  ),
                ],
              ],
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(CdsOverrideOutcome()),
          child: Text(
            widget.allowOverride ? s.actionCancel : s.cdsBlockerAdjustOrder,
          ),
        ),
        if (!widget.allowOverride)
          const SizedBox.shrink()
        else if (!_showOverrideField)
          TextButton(
            onPressed: () => setState(() => _showOverrideField = true),
            child: Text(s.cdsBlockerOverrideButton),
          )
        else
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: _overrideValid
                ? () => Navigator.of(
                    context,
                  ).pop(CdsOverrideOutcome(overrideReason: _overridePayload))
                : null,
            child: Text(s.cdsBlockerOverrideSave),
          ),
      ],
    );
  }

  Widget _issueTile(dynamic issue, {required bool isBlocker}) {
    if (issue is! Map) return const SizedBox.shrink();
    final color = isBlocker ? Colors.red : Colors.orange;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            isBlocker ? Icons.error : Icons.warning_amber,
            color: color,
            size: 18,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              // Prescription-safety issues carry `message`; cdsEngine
              // alerts carry `title`/`description`. Render whichever the
              // payload has so order blockers don't show "{...}".
              (issue['message'] ?? issue['description'] ?? issue['title'])
                      ?.toString() ??
                  issue.toString(),
              style: const TextStyle(fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}
