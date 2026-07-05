// lib/features/productivity/widgets/smart_phrase_field.dart
//
// Drop-in TextField that expands dot-phrase shortcodes inline.
//
// Behaviour:
//   - Watches the controller for the pattern `.xxxx ` or `.xxxx\n` —
//     a dot, alphanumeric code, then a terminator (space / newline).
//   - On match, looks up the code via /api/v1/productivity/phrases/<code>
//     and replaces ".xxxx " with the phrase body. The terminator is
//     preserved so the doctor's typing flow continues.
//   - Bumps `use_count` server-side automatically (the GET endpoint
//     does this).
//   - Inline status chip shows "expanding…" while the round-trip
//     completes; on miss, the dot-phrase stays as typed.
//   - {{TOKEN}} placeholders are kept as-is — the doctor reviews and
//     fills them. (Auto-substitution from encounter context can be
//     added later by passing a token resolver.)

import 'package:flutter/material.dart';
import 'package:vhhealth_staff/core/services/api_client.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class SmartPhraseField extends StatefulWidget {
  const SmartPhraseField({
    super.key,
    required this.controller,
    this.decoration,
    this.focusNode,
    this.minLines = 3,
    this.maxLines = 12,
    this.tokenResolver,
  });

  /// External controller — caller owns disposal.
  final TextEditingController controller;
  final InputDecoration? decoration;
  final FocusNode? focusNode;
  final int minLines;
  final int? maxLines;

  /// Optional resolver for {{TOKEN}} placeholders. Return null to
  /// leave the placeholder in place. Receives the bare token name
  /// (e.g. "HBA1C", not "{{HBA1C}}").
  final String? Function(String token)? tokenResolver;

  @override
  State<SmartPhraseField> createState() => _SmartPhraseFieldState();
}

class _SmartPhraseFieldState extends State<SmartPhraseField> {
  /// Code is a dot followed by alphanumerics or underscores, length 2+,
  /// terminated by space, tab, or newline. Captured in group 1.
  static final _trigger = RegExp(r'\.([a-zA-Z][a-zA-Z0-9_]+)([ \t\n])$');

  bool _busy = false;
  String? _lastFailedCode;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChange);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChange);
    super.dispose();
  }

  Future<void> _onChange() async {
    if (_busy) return;
    final text = widget.controller.text;
    final selectionEnd = widget.controller.selection.baseOffset;
    if (selectionEnd <= 0) return;

    // Only inspect text up to the caret — the user might have moved
    // the cursor back into older text and we don't want to re-expand.
    final pre = text.substring(0, selectionEnd);
    final match = _trigger.firstMatch(pre);
    if (match == null) return;

    final code = '.${match.group(1)!}';
    final terminator = match.group(2)!;
    if (code == _lastFailedCode) return; // don't keep retrying a miss

    final triggerStart = match.start;
    final triggerEnd = match.end;

    setState(() {
      _busy = true;
    });
    try {
      final response = await ApiClient.get(
        '/productivity/phrases/by-code/$code',
      );
      if (!mounted) return;
      if (!response.isSuccess) {
        _lastFailedCode = code;
        return;
      }
      final phrase = response.dataAsMap();
      final body = phrase['body']?.toString();
      if (body == null || body.isEmpty) {
        _lastFailedCode = code;
        return;
      }
      // Resolve placeholders if a resolver was provided.
      final expanded = widget.tokenResolver == null
          ? body
          : body.replaceAllMapped(RegExp(r'\{\{([A-Z0-9_]+)\}\}'), (m) {
              final v = widget.tokenResolver!(m.group(1)!);
              return v ?? m.group(0)!;
            });

      // Splice: pre[0..triggerStart] + expanded + terminator + pre[triggerEnd..end].
      final before = text.substring(0, triggerStart);
      final after = text.substring(triggerEnd);
      final replacement = expanded + terminator;
      final newText = before + replacement + after;
      final newCaret = (before + replacement).length;

      // Suppress re-entry while we set the new text.
      widget.controller.value = TextEditingValue(
        text: newText,
        selection: TextSelection.collapsed(offset: newCaret),
      );
      _lastFailedCode = null;
    } catch (_) {
      _lastFailedCode = code;
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      alignment: Alignment.topRight,
      children: [
        TextField(
          controller: widget.controller,
          focusNode: widget.focusNode,
          minLines: widget.minLines,
          maxLines: widget.maxLines,
          decoration: (widget.decoration ?? const InputDecoration()).copyWith(
            border: const OutlineInputBorder(),
            helperText:
                widget.decoration?.helperText ??
                'Type a dot-phrase like .dmreview followed by space to expand',
          ),
        ),
        if (_busy)
          Padding(
            padding: const EdgeInsets.all(8),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: Theme.of(
                  context,
                ).colorScheme.primary.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 6),
                  AppText(
                    's4.lib.smart_phrase_field.expanding',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
