import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

class DesktopScrollControls extends StatefulWidget {
  final Widget child;
  final Axis axis;
  final double step;
  final EdgeInsets padding;

  const DesktopScrollControls({
    super.key,
    required this.child,
    this.axis = Axis.horizontal,
    this.step = 260,
    this.padding = const EdgeInsets.all(6),
  });

  @override
  State<DesktopScrollControls> createState() => _DesktopScrollControlsState();
}

class _DesktopScrollControlsState extends State<DesktopScrollControls> {
  final _controller = ScrollController();

  bool get _showButtons {
    if (kIsWeb) return true;
    switch (defaultTargetPlatform) {
      case TargetPlatform.windows:
      case TargetPlatform.macOS:
      case TargetPlatform.linux:
        return true;
      default:
        return false;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _scrollBy(double delta) {
    if (!_controller.hasClients) return;
    final target = (_controller.offset + delta).clamp(
      0.0,
      _controller.position.maxScrollExtent,
    );
    _controller.animateTo(
      target,
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOut,
    );
  }

  @override
  Widget build(BuildContext context) {
    final scrollable = Scrollbar(
      controller: _controller,
      thumbVisibility: _showButtons,
      trackVisibility: _showButtons,
      child: SingleChildScrollView(
        controller: _controller,
        scrollDirection: widget.axis,
        child: widget.child,
      ),
    );

    if (!_showButtons) return scrollable;

    if (widget.axis == Axis.vertical) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: Padding(padding: widget.padding, child: scrollable),
          ),
          _ButtonRail(
            firstIcon: Icons.keyboard_arrow_up,
            secondIcon: Icons.keyboard_arrow_down,
            onFirst: () => _scrollBy(-widget.step),
            onSecond: () => _scrollBy(widget.step),
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(padding: widget.padding, child: scrollable),
        _ButtonRow(
          firstIcon: Icons.keyboard_arrow_left,
          secondIcon: Icons.keyboard_arrow_right,
          onFirst: () => _scrollBy(-widget.step),
          onSecond: () => _scrollBy(widget.step),
        ),
      ],
    );
  }
}

class _ButtonRow extends StatelessWidget {
  final IconData firstIcon;
  final IconData secondIcon;
  final VoidCallback onFirst;
  final VoidCallback onSecond;

  const _ButtonRow({
    required this.firstIcon,
    required this.secondIcon,
    required this.onFirst,
    required this.onSecond,
  });

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(6, 4, 6, 6),
        child: Container(
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            border: Border.all(color: AppTheme.divider),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: AppStrings.of(
                  context,
                ).lookup('s4.lib.desktop_scroll_controls.scroll_back'),
                onPressed: onFirst,
                icon: Icon(firstIcon),
              ),
              IconButton(
                tooltip: AppStrings.of(
                  context,
                ).lookup('s4.lib.desktop_scroll_controls.scroll_forward'),
                onPressed: onSecond,
                icon: Icon(secondIcon),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ButtonRail extends StatelessWidget {
  final IconData firstIcon;
  final IconData secondIcon;
  final VoidCallback onFirst;
  final VoidCallback onSecond;

  const _ButtonRail({
    required this.firstIcon,
    required this.secondIcon,
    required this.onFirst,
    required this.onSecond,
  });

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.center,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(2, 6, 6, 6),
        child: Container(
          decoration: BoxDecoration(
            color: AppTheme.cardSurface,
            border: Border.all(color: AppTheme.divider),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: AppStrings.of(
                  context,
                ).lookup('s4.lib.desktop_scroll_controls.scroll_up'),
                onPressed: onFirst,
                icon: Icon(firstIcon),
              ),
              IconButton(
                tooltip: AppStrings.of(
                  context,
                ).lookup('s4.lib.desktop_scroll_controls.scroll_down'),
                onPressed: onSecond,
                icon: Icon(secondIcon),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
