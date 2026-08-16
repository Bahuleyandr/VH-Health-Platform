import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/dietary/screens/kitchen_screen.dart';

Map<String, dynamic> _ticket({
  String id = '1',
  String meal = 'breakfast',
  String status = 'pending',
  String diet = 'diabetic',
  String? patient = 'Asha Menon',
  List<Map<String, dynamic>> selections = const [
    {'id': 1, 'name': 'Ragi Porridge', 'is_veg': true},
  ],
  List<String> allergies = const [],
}) {
  return {
    'id': id,
    'meal_type': meal,
    'status': status,
    'diet_type': diet,
    'patient_name': patient,
    'patient_uid': 'uid-$id',
    'ward': 'Ward A',
    'bed_number': 'A-101',
    'menu_selections': selections,
    'diet_spec': selections.isEmpty
        ? '$diet diet — prepare per diet spec'
        : null,
    'allergies': allergies,
    'service_date': '2026-08-16',
  };
}

Map<String, dynamic> _summary() => {
  'serviceDate': '2026-08-16',
  'totalLive': 3,
  'byMeal': {
    'breakfast': {
      'total': 2,
      'by_diet_type': {'diabetic': 1, 'renal': 1},
      'by_status': {'pending': 2},
    },
    'lunch': {
      'total': 1,
      'by_diet_type': {'diabetic': 1},
      'by_status': {'dispatched': 1},
    },
  },
};

Widget _screen({
  List<Map<String, dynamic>>? tickets,
  Map<String, dynamic>? summary,
  KitchenTicketTransitioner? transition,
  KitchenGenerator? generate,
}) {
  return MaterialApp(
    home: KitchenScreen(
      listTickets: ({
        String? date,
        String? mealType,
        String? status,
        String? ward,
      }) async => tickets ?? [_ticket()],
      fetchSummary: ({String? date}) async => summary ?? _summary(),
      transitionTicket:
          transition ?? (id, status, {String? reason}) async => {'id': id},
      generateTickets: generate ?? ({String? date}) async => {'created': 4},
    ),
  );
}

void main() {
  testWidgets('board tab shows production summary and kitchen tickets '
      'with the next kitchen action', (tester) async {
    await tester.pumpWidget(
      _screen(
        tickets: [
          _ticket(id: '1', status: 'pending', allergies: ['Peanut']),
          _ticket(id: '2', meal: 'lunch', status: 'dispatched'),
        ],
      ),
    );
    await tester.pumpAndSettle();

    // Production summary header with by-diet counts.
    expect(find.text('Production summary'), findsOneWidget);
    expect(find.textContaining('diabetic ×1'), findsWidgets);

    // The pending kitchen ticket renders with patient, menu, allergy
    // warning, and its next-step button; the dispatched one belongs to the
    // trays tab and is not on the board.
    expect(find.text('Asha Menon'), findsOneWidget);
    expect(find.text('Ragi Porridge'), findsOneWidget);
    expect(find.textContaining('Allergies: Peanut'), findsOneWidget);
    expect(find.text('Mark Preparing'), findsOneWidget);
    expect(find.text('Mark Delivered'), findsNothing);
  });

  testWidgets('progressing a ticket calls the transition API with the '
      'next status', (tester) async {
    final calls = <List<String?>>[];
    await tester.pumpWidget(
      _screen(
        tickets: [_ticket(id: '42', status: 'ready')],
        transition: (id, status, {String? reason}) async {
          calls.add([id, status, reason]);
          return {'id': id};
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Mark Dispatched'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('kitchen-next-42')));
    await tester.pumpAndSettle();

    expect(calls, [
      ['42', 'dispatched', null],
    ]);
    expect(find.textContaining('Ticket marked'), findsOneWidget);
  });

  testWidgets('cancelling a ticket requires a reason', (tester) async {
    final calls = <List<String?>>[];
    await tester.pumpWidget(
      _screen(
        tickets: [_ticket(id: '7', status: 'pending')],
        transition: (id, status, {String? reason}) async {
          calls.add([id, status, reason]);
          return {'id': id};
        },
      ),
    );
    await tester.pumpAndSettle();

    // Confirm with an empty reason: rejected client-side, no API call.
    await tester.tap(find.text('Cancel ticket'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Cancel ticket'));
    await tester.pumpAndSettle();
    expect(calls, isEmpty);
    expect(find.text('A cancellation reason is required'), findsOneWidget);

    // With a reason the cancel goes through.
    await tester.tap(find.text('Cancel ticket'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('kitchen-cancel-reason')),
      'patient moved to NPO',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Cancel ticket'));
    await tester.pumpAndSettle();
    expect(calls, [
      ['7', 'cancelled', 'patient moved to NPO'],
    ]);
  });

  testWidgets('trays tab tracks the ward leg dispatched -> delivered -> '
      'collected', (tester) async {
    final calls = <List<String?>>[];
    await tester.pumpWidget(
      _screen(
        tickets: [
          _ticket(id: '1', status: 'pending'),
          _ticket(id: '2', meal: 'lunch', status: 'dispatched'),
          _ticket(id: '3', meal: 'dinner', status: 'delivered'),
        ],
        transition: (id, status, {String? reason}) async {
          calls.add([id, status, reason]);
          return {'id': id};
        },
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Tray tracking'));
    await tester.pumpAndSettle();

    // Only the out-on-the-ward trays appear, each with its ward-leg action.
    expect(find.text('Mark Delivered'), findsOneWidget);
    expect(find.text('Mark Tray collected'), findsOneWidget);
    expect(find.text('Mark Preparing'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('kitchen-next-2')));
    await tester.pumpAndSettle();
    expect(calls, [
      ['2', 'delivered', null],
    ]);
  });
}
