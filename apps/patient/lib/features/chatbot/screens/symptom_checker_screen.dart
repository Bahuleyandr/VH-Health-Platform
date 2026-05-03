import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'package:vhhealth/core/services/api_client.dart';
import 'package:vhhealth/generated/app_localizations.dart';

/// AI-backed symptom checker. User types a free-text complaint, app POSTs to
/// `/chatbot/triage`, and the response is rendered as a triage decision, a
/// ranked differential, and a "Book appointment" shortcut that pre-fills the
/// booking form's reason field with the original complaint.
class SymptomCheckerScreen extends StatefulWidget {
  const SymptomCheckerScreen({super.key});

  @override
  State<SymptomCheckerScreen> createState() => _SymptomCheckerScreenState();
}

class _SymptomCheckerScreenState extends State<SymptomCheckerScreen> {
  final TextEditingController _symptomsCtrl = TextEditingController();
  bool _busy = false;
  Map<String, dynamic>? _result;
  String? _error;

  @override
  void dispose() {
    _symptomsCtrl.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    final text = _symptomsCtrl.text.trim();
    if (text.length < 5) return;
    setState(() {
      _busy = true;
      _result = null;
      _error = null;
    });
    try {
      final resp = await ApiClient.post(
        '/chatbot/triage',
        body: {'symptoms': text},
      );
      if (resp.isSuccess) {
        setState(() => _result = resp.dataAsMap());
      } else {
        setState(() => _error = resp.message ?? 'Triage failed');
      }
    } catch (e) {
      setState(() => _error = 'Triage service unavailable');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  ({Color colour, String label, IconData icon}) _triageVisual(String key) {
    switch (key) {
      case 'urgent_care':
        return (
          colour: Colors.red,
          label: 'Urgent care — go to A&E',
          icon: Icons.emergency,
        );
      case 'see_doctor_now':
        return (
          colour: Colors.orange,
          label: 'See a doctor today',
          icon: Icons.medical_services,
        );
      case 'self_care':
      default:
        return (
          colour: Colors.green,
          label: 'Self-care — monitor at home',
          icon: Icons.home,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Scaffold(
      appBar: AppBar(title: Text(l.symptomCheckerTitle)),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              l.symptomCheckerDescribePrompt,
              style: const TextStyle(fontSize: 13, color: Colors.black54),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _symptomsCtrl,
              maxLines: 5,
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                hintText: 'e.g. severe headache for 2 days with nausea',
              ),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _busy ? null : _run,
              icon: _busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.psychology),
              label: Text(_busy ? 'Thinking…' : 'Check symptoms'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
            if (_result != null) ..._renderResult(_result!),
          ],
        ),
      ),
    );
  }

  List<Widget> _renderResult(Map<String, dynamic> result) {
    final l = AppLocalizations.of(context)!;
    final triageKey = result['triage']?.toString() ?? 'see_doctor_now';
    final visual = _triageVisual(triageKey);
    final summary = result['summary']?.toString() ?? '';
    final differential = (result['differential'] as List?) ?? const [];
    final redFlags = (result['redFlags'] as List?) ?? const [];

    return [
      const SizedBox(height: 24),
      Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: visual.colour.withValues(alpha: 0.12),
          border: Border.all(color: visual.colour.withValues(alpha: 0.5)),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(visual.icon, color: visual.colour, size: 28),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                visual.label,
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  color: visual.colour,
                ),
              ),
            ),
          ],
        ),
      ),
      if (summary.isNotEmpty) ...[
        const SizedBox(height: 10),
        Text(summary, style: const TextStyle(fontSize: 14)),
      ],
      if (redFlags.isNotEmpty) ...[
        const SizedBox(height: 12),
        Text(l.symptomCheckerRedFlags, style: const TextStyle(fontWeight: FontWeight.bold)),
        for (final f in redFlags)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              '• $f',
              style: const TextStyle(color: Colors.red, fontSize: 13),
            ),
          ),
      ],
      if (differential.isNotEmpty) ...[
        const SizedBox(height: 16),
        Text(
          l.symptomCheckerPossibleCauses,
          style: const TextStyle(fontWeight: FontWeight.bold),
        ),
        for (final d in differential)
          ListTile(
            dense: true,
            leading: _likelihoodBadge((d as Map)['likelihood']?.toString()),
            title: Text(d['diagnosis']?.toString() ?? ''),
            contentPadding: EdgeInsets.zero,
          ),
      ],
      if (triageKey != 'urgent_care') ...[
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: () => context.push(
            '/appointments',
            extra: {'reason': _symptomsCtrl.text.trim()},
          ),
          icon: const Icon(Icons.event_available),
          label: Text(l.symptomCheckerBookAppointment),
        ),
      ],
      Padding(
        padding: const EdgeInsets.only(top: 20),
        child: Text(
          l.symptomCheckerDisclaimer,
          style: const TextStyle(fontSize: 11, color: Colors.black54),
        ),
      ),
    ];
  }

  Widget _likelihoodBadge(String? likelihood) {
    final colour = switch (likelihood) {
      'high' => Colors.red,
      'medium' => Colors.orange,
      _ => Colors.grey,
    };
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(color: colour, shape: BoxShape.circle),
    );
  }
}
