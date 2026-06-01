import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/emr/screens/patient_command_board_screen.dart';

void main() {
  group('patient command board scope presentation', () {
    test('labels consultant own-patient scope and capped loaded rows', () {
      final board = {
        'scope': {
          'role_scope': {'type': 'own_patients', 'source': 'doctor_assignment'},
        },
        'counts': {'total': 46, 'loaded': 20, 'returned': 20, 'has_more': true},
      };

      expect(patientCommandBoardScopeLabel(board), 'Patients assigned to you');
      expect(patientCommandBoardScopeDetail(board), 'doctor assignment');
      expect(
        patientCommandBoardLoadedSummary(
          board: board,
          loadedRows: 20,
          visibleRows: 20,
        ),
        'Showing first 20 of 46 patients in your current scope.',
      );
      expect(patientCommandBoardHasMore(board: board, loadedRows: 20), isTrue);
      expect(patientCommandBoardNextOffset(board: board, loadedRows: 20), 20);
    });

    test('describes duty-doctor multi-floor coverage', () {
      final board = {
        'scope': {
          'role_scope': {
            'type': 'duty_doctor',
            'source': 'current_published_medical_roster',
            'floors': [2, 3],
            'wards': ['Second Floor Ward', 'Third Floor Ward'],
          },
        },
        'counts': {'total': 8, 'loaded': 8},
      };

      expect(
        patientCommandBoardScopeLabel(board),
        'Current duty floor coverage',
      );
      expect(
        patientCommandBoardScopeDetail(board),
        'Second Floor Ward, Third Floor Ward',
      );
    });

    test('describes nursing floor coverage from floor-only scope', () {
      final board = {
        'scope': {
          'role_scope': {
            'type': 'ward_nursing',
            'source': 'current_published_nursing_roster',
            'floors': [4],
            'wards': [],
          },
        },
        'counts': {'total': 6, 'loaded': 6},
      };

      expect(patientCommandBoardScopeLabel(board), 'Current nursing floor');
      expect(patientCommandBoardScopeDetail(board), 'Floor 4');
    });

    test('describes unrostered nursing all-floor fallback', () {
      final board = {
        'scope': {
          'role_scope': {
            'type': 'ward_nursing',
            'source': 'all_locations_fallback_no_current_roster',
            'all_floors': true,
            'assignment_count': 0,
          },
        },
        'counts': {'total': 46, 'loaded': 46},
      };

      expect(patientCommandBoardScopeLabel(board), 'All active inpatients');
      expect(patientCommandBoardScopeDetail(board), 'All floors');
    });

    test('describes housekeeping floor scope and filtered rows', () {
      final board = {
        'scope': {
          'role_scope': {
            'type': 'housekeeping',
            'source': 'active_housekeeping_floor_assignment',
            'floors': [3],
            'wards': ['Third Floor Ward'],
          },
        },
        'counts': {'total': 12, 'loaded': 12},
      };

      expect(patientCommandBoardScopeLabel(board), 'Current housekeeping area');
      expect(patientCommandBoardScopeDetail(board), 'Third Floor Ward');
      expect(
        patientCommandBoardLoadedSummary(
          board: board,
          loadedRows: 12,
          visibleRows: 2,
          filter: 'alerts',
        ),
        'Showing 2 filtered rows from 12 loaded; scoped total 12.',
      );
    });

    test('describes governance full scope', () {
      final board = {
        'scope': {
          'role_scope': {
            'type': 'full',
            'source': 'governance_role',
            'all_floors': true,
          },
        },
        'counts': {'total': 46, 'loaded': 46},
      };

      expect(patientCommandBoardScopeLabel(board), 'All active inpatients');
      expect(patientCommandBoardScopeDetail(board), 'All floors');
      expect(
        patientCommandBoardLoadedSummary(
          board: board,
          loadedRows: 46,
          visibleRows: 46,
        ),
        'Showing 46 of 46 patients in your current scope.',
      );
      expect(patientCommandBoardHasMore(board: board, loadedRows: 46), isFalse);
    });

    test('uses backend cumulative loaded count as the next page offset', () {
      final board = {
        'counts': {
          'total': 120,
          'loaded': 100,
          'returned': 50,
          'offset': 50,
          'has_more': true,
        },
      };

      expect(
        patientCommandBoardLoadedSummary(
          board: board,
          loadedRows: 100,
          visibleRows: 100,
        ),
        'Showing first 100 of 120 patients in your current scope.',
      );
      expect(patientCommandBoardHasMore(board: board, loadedRows: 100), isTrue);
      expect(patientCommandBoardNextOffset(board: board, loadedRows: 50), 100);
    });
  });
}
