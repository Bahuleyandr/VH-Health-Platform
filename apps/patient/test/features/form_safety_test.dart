import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:vhhealth/core/providers/user_provider.dart';
import 'package:vhhealth/features/investigations/screens/book_investigation_screen.dart';
import 'package:vhhealth/features/pharmacy/widgets/order_form_tab.dart';
import 'package:vhhealth/features/profile/screens/profile_edit_screen.dart';
import 'package:vhhealth/generated/app_localizations.dart';
import 'package:vhhealth_core/services/http_client.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(_installSecureStorageFake);

  tearDown(() {
    VHHttpClient.resetClientForTesting();
  });

  testWidgets('profile edit validates email before submitting', (tester) async {
    var putCalls = 0;
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.method == 'GET') {
          expect(request.url.path, endsWith('/users/5551234567'));
          return http.Response(
            '{"data":{"user":{"name":"Test Patient","email":""}}}',
            200,
          );
        }
        if (request.method == 'PUT') {
          putCalls++;
          return http.Response('{"success":true}', 200);
        }
        return http.Response('Not found', 404);
      }),
    );
    final userProvider = UserProvider();
    await userProvider.setUser('5551234567', 'Test Patient');

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: userProvider,
        child: const _Harness(child: ProfileEditScreen()),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(1), 'not-an-email');
    await tester.scrollUntilVisible(
      find.text('Save changes'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Save changes'));
    await tester.pump();
    await tester.drag(find.byType(Scrollable).first, const Offset(0, 1200));
    await tester.pump();

    expect(find.text('Enter a valid email address'), findsOneWidget);
    expect(putCalls, 0);
  });

  testWidgets('pharmacy upload validation renders inline instead of snackbar', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      _Harness(
        child: Scaffold(
          body: OrderFormTab(phone: '5551234567', onOrderPlaced: () {}),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Place Order'));
    await tester.pump();

    expect(
      find.text('Please upload a prescription or describe your order'),
      findsOneWidget,
    );
    expect(find.byType(SnackBar), findsNothing);

    await tester.enterText(find.byType(TextField).first, 'Dolo 650 - 2 strips');
    await tester.pump();

    expect(
      find.text('Please upload a prescription or describe your order'),
      findsNothing,
    );
  });

  testWidgets('book investigation submit shows a progress guard', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1200, 2200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    tester.view.physicalSize = const Size(1200, 2200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final submitCompleter = Completer<http.Response>();
    var submitCalls = 0;

    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        if (request.method == 'GET' &&
            request.url.path.endsWith('/investigations/catalog')) {
          return http.Response('{"data":[]}', 200);
        }
        if (request.method == 'POST' &&
            request.url.path.endsWith('/investigations/bookings/create')) {
          submitCalls++;
          return submitCompleter.future;
        }
        return http.Response('Not found', 404);
      }),
    );

    await tester.pumpWidget(const _Harness(child: BookInvestigationScreen()));
    await tester.pumpAndSettle();

    final customTestField = find.byWidgetPredicate(
      (widget) =>
          widget is TextField &&
          widget.decoration?.hintText == 'e.g. CBC, Sugar test, Thyroid',
    );
    await tester.enterText(customTestField, 'CBC');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    _pressActiveFilledButton(tester, 'Continue');
    await tester.pumpAndSettle();

    final addressField = find.byWidgetPredicate(
      (widget) =>
          widget is TextField &&
          widget.decoration?.labelText == 'Collection Address *',
    );
    await tester.enterText(addressField, '123 Main Road');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    _pressActiveFilledButton(tester, 'Continue');
    await tester.pumpAndSettle();

    _pressActiveFilledButton(tester, 'Book Now');
    await tester.pump();

    expect(submitCalls, 1);
    expect(find.text('Booking...'), findsWidgets);
    expect(find.byType(CircularProgressIndicator), findsWidgets);

    final submittingButton = tester.widget<FilledButton>(
      _filledButton('Booking...'),
    );

    expect(submittingButton.onPressed, isNull);
    expect(submitCalls, 1);

    submitCompleter.complete(
      http.Response('{"data":{"id":123,"booking_number":"INV-1"}}', 200),
    );
    await tester.pumpAndSettle();
  });
}

void _pressActiveFilledButton(WidgetTester tester, String label) {
  final button = tester.widget<FilledButton>(_activeFilledButton(label));
  button.onPressed!();
}

Finder _filledButton(String label) {
  return find
      .ancestor(of: find.text(label), matching: find.byType(FilledButton))
      .last;
}

Finder _activeFilledButton(String label) {
  return find
      .ancestor(
        of: find.text(label),
        matching: find.byWidgetPredicate(
          (widget) => widget is FilledButton && widget.onPressed != null,
        ),
      )
      .last;
}

class _Harness extends StatelessWidget {
  const _Harness({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: child,
    );
  }
}

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(call.arguments as Map);
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key']] = args['value'] as String;
            return null;
          case 'delete':
            store.remove(args['key']);
            return null;
          case 'readAll':
            return Map<String, String>.from(store);
          case 'deleteAll':
            store.clear();
            return null;
          case 'containsKey':
            return store.containsKey(args['key']);
          default:
            return null;
        }
      });
}
