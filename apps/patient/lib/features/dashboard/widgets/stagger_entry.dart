import 'package:flutter/material.dart';

/// Wraps a child in a one-shot fade + slide-up animation. The dashboard
/// uses these around each section so the page assembles with a brief
/// staggered cascade on first paint (or after a hot reload).
///
/// Pass an [index] to offset the start time — the controller fires
/// once per build of the parent, so the first index starts immediately
/// and subsequent ones lag by [stepMs] each.
class StaggerEntry extends StatefulWidget {
  final int index;
  final Widget child;
  final int baseDelayMs;
  final int stepMs;
  final int durationMs;
  final double slideFrom;

  const StaggerEntry({
    super.key,
    required this.index,
    required this.child,
    this.baseDelayMs = 80,
    this.stepMs = 60,
    this.durationMs = 360,
    this.slideFrom = 16,
  });

  @override
  State<StaggerEntry> createState() => _StaggerEntryState();
}

class _StaggerEntryState extends State<StaggerEntry>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _opacity;
  late final Animation<Offset> _offset;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: widget.durationMs),
    );
    _opacity = CurvedAnimation(parent: _controller, curve: Curves.easeOut);
    _offset = Tween<Offset>(
      begin: Offset(0, widget.slideFrom / 100),
      end: Offset.zero,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic));

    final delay = Duration(
      milliseconds: widget.baseDelayMs + widget.index * widget.stepMs,
    );
    Future.delayed(delay, () {
      if (mounted) _controller.forward();
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _opacity,
      child: SlideTransition(position: _offset, child: widget.child),
    );
  }
}
