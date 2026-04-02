import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

/// Error boundary widget that catches Flutter errors in its subtree
/// and displays a friendly error message instead of crashing.
///
/// Supports custom error builders and fallback widgets.
class ErrorBoundary extends StatefulWidget {
  final Widget child;
  final Widget Function(Object error, StackTrace? stack)? errorBuilder;
  final Widget? fallback;

  const ErrorBoundary({
    super.key,
    required this.child,
    this.errorBuilder,
    this.fallback,
  });

  @override
  State<ErrorBoundary> createState() => _ErrorBoundaryState();
}

class _ErrorBoundaryState extends State<ErrorBoundary> {
  Object? _error;
  StackTrace? _stackTrace;

  FlutterExceptionHandler? _previousHandler;

  @override
  void initState() {
    super.initState();
    _previousHandler = FlutterError.onError;

    FlutterError.onError = (FlutterErrorDetails details) {
      if (mounted) {
        setState(() {
          _error = details.exception;
          _stackTrace = details.stack;
        });
      } else {
        _previousHandler?.call(details);
      }
    };
  }

  @override
  void dispose() {
    FlutterError.onError = _previousHandler;
    super.dispose();
  }

  void _retry() {
    setState(() {
      _error = null;
      _stackTrace = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      if (widget.errorBuilder != null) {
        return widget.errorBuilder!(_error!, _stackTrace);
      } else if (widget.fallback != null) {
        return widget.fallback!;
      } else {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline, size: 56, color: Colors.red),
                const SizedBox(height: 16),
                const Text(
                  'Something went wrong',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 8),
                const Text(
                  'An unexpected error occurred. Please try again.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey),
                ),
                const SizedBox(height: 24),
                ElevatedButton.icon(
                  onPressed: _retry,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Try Again'),
                ),
              ],
            ),
          ),
        );
      }
    }

    return widget.child;
  }
}
