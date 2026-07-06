import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_core/vhhealth_core.dart';

void main() {
  testWidgets('signature pad captures a stroke and exports PNG bytes', (
    tester,
  ) async {
    final controller = SignaturePadController();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 320,
              child: SignaturePadField(
                controller: controller,
                label: 'Your signature',
                clearLabel: 'Clear',
                emptyHint: 'Sign here',
              ),
            ),
          ),
        ),
      ),
    );

    final canvas = find
        .descendant(
          of: find.byType(SignaturePadField),
          matching: find.byType(CustomPaint),
        )
        .last;
    await tester.dragFrom(tester.getCenter(canvas), const Offset(90, 12));
    await tester.pump();

    final pngBytes = await tester.runAsync(
      () => controller.toPngBytes(width: 320, height: 140),
    );
    expect(controller.isNotEmpty, isTrue);
    expect(pngBytes, isNotNull);
    expect(pngBytes!.take(8).toList(), [
      0x89,
      0x50,
      0x4E,
      0x47,
      0x0D,
      0x0A,
      0x1A,
      0x0A,
    ]);
  });
}
