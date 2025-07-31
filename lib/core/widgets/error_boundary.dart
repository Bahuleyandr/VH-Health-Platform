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
  FlutterErrorDetails? _flutterErrorDetails;

  @override
  void initState() {
    super.initState();
    // Store previous error handler
    final oldHandler = FlutterError.onError;
    
    // Set new error handler
    FlutterError.onError = (FlutterErrorDetails details) {
      // Only catch errors from this widget's subtree
      if (mounted && _isInSubtree(details)) {
        setState(() {
          _error = details.exception;
          _stackTrace = details.stack;
          _flutterErrorDetails = details;
        });
      } else {
        // Pass to previous handler if not our error
        oldHandler?.call(details);
      }
    };
  }

  bool _isInSubtree(FlutterErrorDetails details) {
    // Basic check - in production you'd want more sophisticated checking
    return true;
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