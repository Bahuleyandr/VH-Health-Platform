// Pins the partograph view "New entry" FAB to GoRouter navigation.
//
// The app is a GoRouter app (MaterialApp.router); the FAB previously used
// Navigator-1.0 `Navigator.of(context).pushNamed(...)`, which has no route
// generator under GoRouter and threw at runtime. This test fails if that
// regression returns: under `pushNamed` the entry route stub never appears.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/features/maternity/screens/partograph_view_screen.dart';

void _installSecureStorageFake() {
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  final store = <String, String>{};

  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (MethodCall call) async {
        final args = Map<String, dynamic>.from(
          call.arguments as Map? ?? const {},
        );
        switch (call.method) {
          case 'read':
            return store[args['key']];
          case 'write':
            store[args['key'] as String] = args['value'] as String;
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

http.Response _ok(Object data) => http.Response(
  jsonEncode({'success': true, 'data': data}),
  200,
  headers: {'content-type': 'application/json'},
);

void main() {
  setUp(() {
    _installSecureStorageFake();
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/maternity/labor-admissions/7')) {
          return _ok({'id': 7, 'status': 'active'});
        }
        if (path.endsWith('/maternity/partograph/labor/7')) {
          return _ok(const []);
        }
        return http.Response(
          jsonEncode({'success': false, 'message': 'Unexpected $path'}),
          404,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
  });

  tearDown(VHHttpClient.resetClientForTesting);

  testWidgets('new-entry FAB navigates to the entry route via GoRouter', (
    tester,
  ) async {
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (_, _) => const PartographViewScreen(laborAdmissionId: 7),
        ),
        GoRoute(
          path: '/maternity/partograph/:laborId',
          builder: (_, state) =>
              Text('entry-stub-${state.pathParameters['laborId']}'),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();

    // Screen loaded (admission has no phase anchor, chart shows placeholder)
    // and the FAB is available.
    expect(find.byType(FloatingActionButton), findsOneWidget);

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();

    // Navigator-1.0 pushNamed would throw here (no onGenerateRoute in a
    // GoRouter app); context.push resolves the declared GoRoute.
    expect(find.text('entry-stub-7'), findsOneWidget);
  });
}
