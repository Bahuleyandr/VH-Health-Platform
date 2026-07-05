import 'package:flutter/material.dart';

/// An [ElevatedButton] that disables itself while [onPressed] is executing,
/// preventing duplicate submissions from rapid taps.
///
/// Usage:
/// ```dart
/// DebouncedButton(
///   onPressed: () async {
///     await ApiClient.post('/staff/attendance', body: {...});
///   },
///   child: const AppText('attendance.check_in'),
/// )
/// ```
class DebouncedButton extends StatefulWidget {
  const DebouncedButton({
    super.key,
    required this.onPressed,
    required this.child,
    this.style,
    this.icon,
  });

  final Future<void> Function()? onPressed;
  final Widget child;
  final ButtonStyle? style;
  final Widget? icon;

  @override
  State<DebouncedButton> createState() => _DebouncedButtonState();
}

class _DebouncedButtonState extends State<DebouncedButton> {
  bool _busy = false;

  Future<void> _handlePress() async {
    if (_busy || widget.onPressed == null) return;
    setState(() => _busy = true);
    try {
      await widget.onPressed!();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final effectiveOnPressed = (_busy || widget.onPressed == null)
        ? null
        : _handlePress;

    if (widget.icon != null) {
      return ElevatedButton.icon(
        onPressed: effectiveOnPressed,
        style: widget.style,
        icon: _busy
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : widget.icon!,
        label: widget.child,
      );
    }

    return ElevatedButton(
      onPressed: effectiveOnPressed,
      style: widget.style,
      child: _busy
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                widget.child,
                const SizedBox(width: 8),
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ],
            )
          : widget.child,
    );
  }
}
