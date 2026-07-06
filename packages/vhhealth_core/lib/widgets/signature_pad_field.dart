import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

class SignaturePadController extends ChangeNotifier {
  final List<List<Offset>> _strokes = <List<Offset>>[];
  Size _canvasSize = const Size(640, 220);

  bool get isEmpty => _strokes.every((stroke) => stroke.isEmpty);
  bool get isNotEmpty => !isEmpty;

  void clear() {
    _strokes.clear();
    notifyListeners();
  }

  Future<Uint8List?> toPngBytes({int width = 900, int height = 320}) async {
    if (isEmpty) return null;

    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final paint = Paint()
      ..color = Colors.black
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    final dotPaint = Paint()
      ..color = Colors.black
      ..style = PaintingStyle.fill;

    canvas.drawColor(Colors.white, BlendMode.src);
    final scaleX = width / _canvasSize.width;
    final scaleY = height / _canvasSize.height;
    canvas.scale(scaleX, scaleY);
    for (final stroke in _strokes) {
      if (stroke.length == 1) {
        canvas.drawCircle(stroke.first, 1.8, dotPaint);
        continue;
      }
      for (var i = 1; i < stroke.length; i += 1) {
        canvas.drawLine(stroke[i - 1], stroke[i], paint);
      }
    }

    final picture = recorder.endRecording();
    final image = await picture.toImage(width, height);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    picture.dispose();
    return data?.buffer.asUint8List();
  }

  void _setCanvasSize(Size size) {
    if (size.width <= 0 || size.height <= 0) return;
    _canvasSize = size;
  }

  void _start(Offset point) {
    _strokes.add(<Offset>[point]);
    notifyListeners();
  }

  void _append(Offset point) {
    if (_strokes.isEmpty) _strokes.add(<Offset>[]);
    _strokes.last.add(point);
    notifyListeners();
  }
}

class SignaturePadField extends StatefulWidget {
  final SignaturePadController controller;
  final String label;
  final String clearLabel;
  final String emptyHint;
  final double height;
  final bool enabled;

  const SignaturePadField({
    super.key,
    required this.controller,
    required this.label,
    required this.clearLabel,
    required this.emptyHint,
    this.height = 180,
    this.enabled = true,
  });

  @override
  State<SignaturePadField> createState() => _SignaturePadFieldState();
}

class _SignaturePadFieldState extends State<SignaturePadField> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChanged);
  }

  @override
  void didUpdateWidget(SignaturePadField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == widget.controller) return;
    oldWidget.controller.removeListener(_onChanged);
    widget.controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final borderColor = widget.controller.isEmpty
        ? Theme.of(context).colorScheme.outline
        : Theme.of(context).colorScheme.primary;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                widget.label,
                style: Theme.of(context).textTheme.labelLarge,
              ),
            ),
            TextButton(
              onPressed: widget.enabled && widget.controller.isNotEmpty
                  ? widget.controller.clear
                  : null,
              child: Text(widget.clearLabel),
            ),
          ],
        ),
        LayoutBuilder(
          builder: (context, constraints) {
            final size = Size(constraints.maxWidth, widget.height);
            widget.controller._setCanvasSize(size);
            return GestureDetector(
              onPanStart: widget.enabled
                  ? (details) => widget.controller._start(details.localPosition)
                  : null,
              onPanUpdate: widget.enabled
                  ? (details) =>
                        widget.controller._append(details.localPosition)
                  : null,
              child: Container(
                height: widget.height,
                width: double.infinity,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: borderColor),
                ),
                child: CustomPaint(
                  painter: _SignaturePadPainter(widget.controller._strokes),
                  child: widget.controller.isEmpty
                      ? Center(
                          child: Text(
                            widget.emptyHint,
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.outline,
                            ),
                          ),
                        )
                      : const SizedBox.expand(),
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}

class _SignaturePadPainter extends CustomPainter {
  final List<List<Offset>> strokes;

  const _SignaturePadPainter(this.strokes);

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.black
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    final dotPaint = Paint()
      ..color = Colors.black
      ..style = PaintingStyle.fill;

    for (final stroke in strokes) {
      if (stroke.length == 1) {
        canvas.drawCircle(stroke.first, 1.8, dotPaint);
        continue;
      }
      for (var i = 1; i < stroke.length; i += 1) {
        canvas.drawLine(stroke[i - 1], stroke[i], paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _SignaturePadPainter oldDelegate) {
    return true;
  }
}
