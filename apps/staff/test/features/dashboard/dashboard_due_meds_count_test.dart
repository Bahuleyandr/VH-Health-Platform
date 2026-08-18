import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/dashboard/dashboard_due_meds_count.dart';

void main() {
  group('dashboardDueMedsCountFromRaw', () {
    test('counts the List the backend returns under data', () {
      expect(
        dashboardDueMedsCountFromRaw({
          'success': true,
          'data': [{}, {}, {}],
        }),
        3,
      );
    });

    test('counts an empty due list as 0 (real zero, not degraded)', () {
      expect(
        dashboardDueMedsCountFromRaw({'success': true, 'data': <dynamic>[]}),
        0,
      );
    });

    test('counts a bare top-level List', () {
      expect(dashboardDueMedsCountFromRaw([{}, {}]), 2);
    });

    test('tolerates a map-wrapped due/medications/items list', () {
      expect(
        dashboardDueMedsCountFromRaw({
          'data': {
            'due': [{}, {}, {}, {}],
          },
        }),
        4,
      );
      expect(
        dashboardDueMedsCountFromRaw({
          'data': {
            'medications': [{}],
          },
        }),
        1,
      );
      expect(
        dashboardDueMedsCountFromRaw({
          'data': {'items': <dynamic>[]},
        }),
        0,
      );
    });

    test('returns null for an unrecognised shape (avoids a false 0)', () {
      expect(dashboardDueMedsCountFromRaw(null), isNull);
      expect(dashboardDueMedsCountFromRaw('oops'), isNull);
      expect(dashboardDueMedsCountFromRaw({'data': 42}), isNull);
      expect(dashboardDueMedsCountFromRaw({'no_data': true}), isNull);
    });
  });
}
