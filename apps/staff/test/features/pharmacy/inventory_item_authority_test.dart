import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vhhealth_core/services/http_client.dart';
import 'package:vhhealth_staff/core/providers/theme_provider.dart';
import 'package:vhhealth_staff/features/pharmacy/screens/pharmacy_screen.dart';
import 'package:vhhealth_staff/l10n/app_strings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({
      'staff_role': 'STORES_PURCHASE_INCHARGE',
    });
    SharedPreferences.setMockInitialValues({});
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  tearDown(() {
    VHHttpClient.resetClientForTesting();
    VHHttpClient.onSessionExpired = null;
  });

  http.Response ok(Object data, {Map<String, dynamic>? meta}) => http.Response(
    jsonEncode({'success': true, 'data': data, 'meta': ?meta}),
    200,
    headers: {'content-type': 'application/json'},
  );

  final catalog = <Map<String, dynamic>>[
    {
      'id': 17,
      'name': 'Canonical Morphine',
      'generic_name': 'Morphine',
      'manufacturer': 'Canonical Pharma',
      'form': 'tablet',
      'strength': '10 mg',
      'pack_size': '10 tablets',
    },
  ];

  Future<void> pumpInventory(
    WidgetTester tester, {
    required List<Map<String, dynamic>> facilities,
    required List<Map<String, dynamic>> catalogItems,
    required Future<http.Response> Function(http.Request request) onCreate,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1200, 2200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    VHHttpClient.setClientForTesting(
      MockClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/pharmacy-orders/catalog')) {
          return ok({'catalog': catalogItems});
        }
        if (path.endsWith('/pharmacy-orders/counter-sales/facilities')) {
          return ok({'facilities': facilities});
        }
        if (path.endsWith('/pharmacy/inventory/v2/items')) {
          if (request.method == 'POST') return onCreate(request);
          return ok({'items': <Object>[]});
        }
        if (path.endsWith('/pharmacy/inventory/v2/expiry-alerts')) {
          return ok({'alerts': <Object>[]});
        }
        if (path.endsWith('/pharmacy-orders/ward-indents')) {
          return ok(
            {'indents': <Object>[]},
            meta: {
              'pagination': {'has_more': false},
            },
          );
        }
        return ok(<String, dynamic>{});
      }),
    );

    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ThemeProvider(),
        child: const MaterialApp(home: PharmacyScreen()),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.byType(Tab).last);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'add inventory selects canonical catalog identity in an authorized facility',
    (tester) async {
      var createCalls = 0;
      Map<String, dynamic>? createdBody;
      await pumpInventory(
        tester,
        facilities: const [
          {
            'facility_id': 8,
            'display_name': 'Main Pharmacy',
            'facility_code': 'MAIN',
          },
          {
            'facility_id': 12,
            'display_name': 'Satellite Pharmacy',
            'facility_code': 'SAT',
          },
        ],
        catalogItems: catalog,
        onCreate: (request) async {
          createCalls += 1;
          createdBody = Map<String, dynamic>.from(
            jsonDecode(request.body) as Map,
          );
          return ok({'id': 501});
        },
      );

      await tester.tap(
        find.byKey(const ValueKey('pharmacy-inventory-facility-0-2')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Satellite Pharmacy').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add Item'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('pharmacy-inventory-sku')),
        'MORPH-10',
      );
      await tester.tap(
        find.byKey(const ValueKey('pharmacy-inventory-create-submit')),
      );
      await tester.pump();
      expect(createCalls, 0);
      expect(
        find.text(
          'Select a medication from the canonical catalog before saving.',
        ),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const ValueKey('pharmacy-inventory-catalog')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Canonical Morphine').last);
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('pharmacy-inventory-create-submit')),
      );
      await tester.pumpAndSettle();

      expect(createCalls, 1);
      expect(createdBody, containsPair('facility_id', 12));
      expect(createdBody, containsPair('catalog_id', 17));
      expect(createdBody, containsPair('sku_code', 'MORPH-10'));
      expect(createdBody, containsPair('display_name', 'Canonical Morphine'));
      expect(createdBody, containsPair('generic_name', 'Morphine'));
      expect(createdBody, containsPair('manufacturer', 'Canonical Pharma'));
      expect(createdBody, containsPair('form', 'tablet'));
      expect(createdBody, containsPair('strength', '10 mg'));
      expect(createdBody, containsPair('pack_size', '10 tablets'));
    },
  );

  testWidgets(
    'composition-curation refusal shows operator action without a retry',
    (tester) async {
      var createCalls = 0;
      await pumpInventory(
        tester,
        facilities: const [
          {
            'facility_id': 8,
            'display_name': 'Main Pharmacy',
            'facility_code': 'MAIN',
          },
        ],
        catalogItems: catalog,
        onCreate: (request) async {
          createCalls += 1;
          return http.Response(
            jsonEncode({
              'success': false,
              'message': 'The selected catalog item has no authoritative composition identity',
              'code': 'PHARMACY_CATALOG_COMPOSITION_REQUIRED',
              'details': {
                'catalog_id': 17,
                'next_action': 'REVIEW_CATALOG_COMPOSITION',
              },
            }),
            409,
            headers: {'content-type': 'application/json'},
          );
        },
      );

      await tester.tap(find.text('Add Item'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('pharmacy-inventory-catalog')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Canonical Morphine').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('pharmacy-inventory-sku')),
        'MORPH-10',
      );
      await tester.tap(
        find.byKey(const ValueKey('pharmacy-inventory-create-submit')),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(createCalls, 1);
      expect(
        find.text(
          'Catalog item 17 has no authoritative composition identity. '
          'No inventory item was created. A governed catalog-composition '
          'review must be completed before you retry.',
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('pharmacy-inventory-create-submit')),
        findsOneWidget,
      );
      await tester.pump(const Duration(seconds: 1));
      expect(createCalls, 1);
    },
  );

  testWidgets('add inventory does not request without a granted facility', (
    tester,
  ) async {
    var createCalls = 0;
    await pumpInventory(
      tester,
      facilities: const [],
      catalogItems: catalog,
      onCreate: (request) async {
        createCalls += 1;
        return ok({'id': 501});
      },
    );

    await tester.tap(find.text('Add Item'));
    await tester.pump();

    expect(createCalls, 0);
    // The inventory tab already carries a STANDING banner with this exact
    // text whenever the operator holds no pharmacy grants, so a bare
    // find.text would be satisfied by the banner alone even if the tap
    // silently did nothing. Scope the refusal to the SnackBar the tap
    // itself raised.
    expect(
      find.descendant(
        of: find.byType(SnackBar),
        matching: find.text(
          'Select a facility from your active pharmacy grants before continuing.',
        ),
      ),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('pharmacy-inventory-catalog')),
      findsNothing,
    );
  });

  testWidgets('add inventory does not request without an active catalog item', (
    tester,
  ) async {
    var createCalls = 0;
    await pumpInventory(
      tester,
      facilities: const [
        {
          'facility_id': 8,
          'display_name': 'Main Pharmacy',
          'facility_code': 'MAIN',
        },
      ],
      catalogItems: const [],
      onCreate: (request) async {
        createCalls += 1;
        return ok({'id': 501});
      },
    );

    await tester.tap(find.text('Add Item'));
    await tester.pump();

    expect(createCalls, 0);
    expect(
      find.text(
        'Select a medication from the canonical catalog before saving.',
      ),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('pharmacy-inventory-catalog')),
      findsNothing,
    );
  });

  test('composition-curation copy has technical parity in every locale', () {
    const key = 'pharmacy.inventory.composition_review_required';
    final english = AppStrings.forLocale(const Locale('en'))
        .format(key, const {'catalogId': 17});

    for (final language in const ['en', 'hi', 'ta', 'te', 'ml']) {
      final message = AppStrings.forLocale(Locale(language))
          .format(key, const {'catalogId': 17});
      expect(message, isNot(key), reason: '$language must define $key');
      expect(
        message,
        contains('17'),
        reason: '$language must retain catalogId',
      );
      if (language != 'en') {
        expect(
          message,
          isNot(english),
          reason: '$language must not silently fall back to English',
        );
      }
    }
  });
}
