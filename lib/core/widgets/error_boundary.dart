import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

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
    // Store previous error handler so we can restore it on dispose
    _previousHandler = FlutterError.onError;

    FlutterError.onError = (FlutterErrorDetails details) {
      if (mounted) {
        setState(() {
          _error = details.exception;
          _stackTrace = details.stack;
        });
      } else {
        // Forward to previous handler if we're not mounted
        _previousHandler?.call(details);
      }
    };
  }

  @override
  void dispose() {
    // Restore the previous error handler to avoid leaking our closure
    FlutterError.onError = _previousHandler;
    super.dispose();
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
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48, color: Colors.red),
              const SizedBox(height: 16),
              Text('Error: ${_error.toString()}'),
            ],
          ),
        );
      }
    }

    return widget.child;
  }
}
