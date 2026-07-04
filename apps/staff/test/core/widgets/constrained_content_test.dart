import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/core/widgets/constrained_content.dart';

void main() {
  void setViewSize(WidgetTester tester, Size size) {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  group('ConstrainedContent', () {
    testWidgets('caps wide workbench content and keeps height bounded', (
      tester,
    ) async {
      const key = Key('content');
      setViewSize(tester, const Size(3000, 700));

      await tester.pumpWidget(
        const Directionality(
          textDirection: TextDirection.ltr,
          child: ConstrainedContent(child: SizedBox.expand(key: key)),
        ),
      );

      expect(tester.getSize(find.byKey(key)), const Size(1280, 700));
    });

    testWidgets('uses the available width below the desktop maximum', (
      tester,
    ) async {
      const key = Key('content');
      setViewSize(tester, const Size(720, 640));

      await tester.pumpWidget(
        const Directionality(
          textDirection: TextDirection.ltr,
          child: ConstrainedContent(child: SizedBox.expand(key: key)),
        ),
      );

      expect(tester.getSize(find.byKey(key)), const Size(720, 640));
    });

    testWidgets('preserves finite height for Column children with Expanded', (
      tester,
    ) async {
      setViewSize(tester, const Size(2200, 640));

      await tester.pumpWidget(
        const Directionality(
          textDirection: TextDirection.ltr,
          child: ConstrainedContent(
            child: Column(
              children: [
                SizedBox(height: 40),
                Expanded(child: ColoredBox(color: Colors.blue)),
              ],
            ),
          ),
        ),
      );

      expect(tester.takeException(), isNull);
    });
  });
}
