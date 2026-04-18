import 'package:flutter/material.dart';

/// Outcome of the CDS hard-block modal. If [overrideReason] is non-null, the
/// clinician has chosen to proceed with a recorded override. Otherwise the
/// prescription save is cancelled.
class CdsOverrideOutcome {
  CdsOverrideOutcome({this.overrideReason});
  final String? overrideReason;
  bool get shouldProceed => overrideReason != null && overrideReason!.trim().length >= 5;
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
  });

  final List<dynamic> blockers;
  final List<dynamic> warnings;

  static Future<CdsOverrideOutcome?> show(
    BuildContext context, {
    required List<dynamic> blockers,
    required List<dynamic> warnings,
  }) {
    return showDialog<CdsOverrideOutcome>(
      context: context,
      barrierDismissible: false,
      builder: (_) => CdsBlockerModal(blockers: blockers, warnings: warnings),
    );
  }

  @override
  State<CdsBlockerModal> createState() => _CdsBlockerModalState();
}

class _CdsBlockerModalState extends State<CdsBlockerModal> {
  final TextEditingController _reasonCtrl = TextEditingController();
  bool _showOverrideField = false;

  @override
  void dispose() {
    _reasonCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final hasAllergyBlocker = widget.blockers.any(
      (b) => b is Map && b['type'] == 'ALLERGY_CONFLICT',
    );

    return AlertDialog(
      title: const Row(
        children: [
          Icon(Icons.block, color: Colors.red, size: 28),
          SizedBox(width: 8),
          Expanded(
            child: Text('Prescription blocked', style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Clinical decision support flagged the following issues. '
              'Cancel to revise the prescription, or override with a documented reason.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            ...widget.blockers.map((b) => _issueTile(b, isBlocker: true)),
            if (widget.warnings.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text('Warnings',
                  style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.bold)),
              ...widget.warnings.map((w) => _issueTile(w, isBlocker: false)),
            ],
            if (_showOverrideField) ...[
              const SizedBox(height: 12),
              if (hasAllergyBlocker)
                Container(
                  padding: const EdgeInsets.all(8),
                  margin: const EdgeInsets.only(bottom: 8),
                  decoration: BoxDecoration(
                    color: Colors.orange.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: Colors.orange.withValues(alpha: 0.5)),
                  ),
                  child: const Text(
                    'Allergy conflict: reference the supervising physician who approved '
                    'this override in your reason.',
                    style: TextStyle(fontSize: 12),
                  ),
                ),
              TextField(
                controller: _reasonCtrl,
                maxLines: 3,
                autofocus: true,
                decoration: const InputDecoration(
                  labelText: 'Override reason (required, min 5 chars)',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(CdsOverrideOutcome()),
          child: const Text('Cancel'),
        ),
        if (!_showOverrideField)
          TextButton(
            onPressed: () => setState(() => _showOverrideField = true),
            child: const Text('Override'),
          )
        else
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: _reasonCtrl.text.trim().length >= 5
                ? () => Navigator.of(context).pop(
                    CdsOverrideOutcome(overrideReason: _reasonCtrl.text.trim()))
                : null,
            child: const Text('Override & save'),
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
          Icon(isBlocker ? Icons.error : Icons.warning_amber, color: color, size: 18),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              issue['message']?.toString() ?? issue.toString(),
              style: const TextStyle(fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}
