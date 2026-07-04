import 'package:flutter/material.dart';

class WorkbenchSplitView extends StatelessWidget {
  final Widget leading;
  final Widget trailing;
  final double trailingWidth;
  final Widget divider;

  const WorkbenchSplitView({
    super.key,
    required this.leading,
    required this.trailing,
    this.trailingWidth = 420,
    this.divider = const VerticalDivider(width: 1),
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(child: leading),
        divider,
        SizedBox(width: trailingWidth, child: trailing),
      ],
    );
  }
}
