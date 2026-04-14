import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

/// Invisible overlay widget that listens to `staff:code-blue` events and shows
/// a blocking full-screen modal the moment a Code Blue fires. Mount once —
/// inside `StaffScaffold` is sufficient since every route rebuilds it.
///
/// The listener also transparently initializes the shared [RealtimeClient]
/// connection, so this widget is the canonical "turn on the real-time fabric"
/// hook for the staff app.
class CodeBlueListener extends StatefulWidget {
  const CodeBlueListener({super.key, required this.child});

  final Widget child;

  @override
  State<CodeBlueListener> createState() => _CodeBlueListenerState();
}

class _CodeBlueListenerState extends State<CodeBlueListener> {
  StreamSubscription<RealtimeEvent>? _codeBlueSub;
  bool _dialogOpen = false;

  @override
  void initState() {
    super.initState();
    _attach();
  }

  Future<void> _attach() async {
    final rt = RealtimeClient.instance;
    await rt.connect();
    _codeBlueSub = rt.events('staff:code-blue').listen(_onCodeBlue);
  }

  void _onCodeBlue(RealtimeEvent event) {
    if (_dialogOpen || !mounted) return;
    _dialogOpen = true;
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      useRootNavigator: true,
      builder: (ctx) {
        return AlertDialog(
          backgroundColor: Colors.red.shade900,
          titlePadding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          title: Row(
            children: [
              const Icon(Icons.emergency, color: Colors.white, size: 32),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'CODE BLUE',
                  style: Theme.of(ctx).textTheme.headlineSmall?.copyWith(
                        color: Colors.white,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 2,
                      ),
                ),
              ),
            ],
          ),
          content: DefaultTextStyle(
            style: const TextStyle(color: Colors.white, fontSize: 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (event.data['ward'] != null)
                  Text('Ward: ${event.data['ward']}'),
                if (event.data['bedNumber'] != null)
                  Text('Bed: ${event.data['bedNumber']}'),
                Text('Patient ID: ${event.data['patientId'] ?? 'Unknown'}'),
                if (event.data['reason'] != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    '${event.data['reason']}',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ],
                const SizedBox(height: 12),
                const Text(
                  'Respond immediately.',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              style: TextButton.styleFrom(
                foregroundColor: Colors.white,
                backgroundColor: Colors.red.shade700,
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              ),
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('ACKNOWLEDGED', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ],
        );
      },
    ).whenComplete(() {
      _dialogOpen = false;
    });
  }

  @override
  void dispose() {
    _codeBlueSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
