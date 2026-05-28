import {
  scoreStaffLeaveRisk,
  summarizeShiftRisks,
} from '../../services/ai/staffLeaveForecastService.js';

const forecastDates = ['2026-05-28', '2026-05-29', '2026-05-30'];

function staff(overrides = {}) {
  return {
    id: 42,
    uid: '11111111-1111-4111-8111-111111111111',
    name: 'Test Staff',
    role: 'HOUSEKEEPING_STAFF',
    ...overrides,
  };
}

describe('staff leave roster forecasting', () => {
  it('uses approved leave as a high visible staffing risk, not a silent roster change', () => {
    const score = scoreStaffLeaveRisk({
      staff: staff(),
      forecastDates,
      department: 'housekeeping',
      leaveRows: [{
        staff_id: 42,
        leave_status: 'approved',
        leave_type: 'casual',
        reason: 'Family function',
        start_date: '2026-05-29',
        end_date: '2026-05-29',
      }],
    });

    expect(score.risk_band).toBe('high');
    expect(score.top_factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'approved_leave', source: 'leave_applications' }),
      ])
    );
    expect(score.date_risks.find((row) => row.date === '2026-05-29')).toEqual(
      expect.objectContaining({
        known_approved_leave: true,
        risk_band: 'high',
      })
    );
  });

  it('combines calendar, commute, and weather signals into explainable factors', () => {
    const score = scoreStaffLeaveRisk({
      staff: staff(),
      forecastDates,
      department: 'housekeeping',
      leaveRows: [{
        staff_id: 42,
        leave_status: 'pending',
        reason: 'Travel during festival',
        start_date: '2026-05-28',
        end_date: '2026-05-30',
      }],
      commuteProfile: {
        id: 9,
        commute_band: 'very_long',
        risk_weight: 18,
      },
      calendarEvents: [{
        id: 1,
        title: 'Local festival',
        event_type: 'festival',
        start_date: '2026-05-28',
        end_date: '2026-05-30',
        risk_weight: 20,
        applies_departments: ['housekeeping'],
      }],
      weatherSignals: [{
        id: 3,
        signal_date: '2026-05-29',
        signal_type: 'heavy_rain',
        severity: 'high',
        risk_weight: 18,
        provider_status: 'manual',
      }],
    });

    expect(score.score).toBeGreaterThanOrEqual(50);
    expect(score.top_factors.map((item) => item.code)).toEqual(
      expect.arrayContaining(['pending_leave', 'commute', 'seasonal_reasons'])
    );
    expect(score.date_risks.find((row) => row.date === '2026-05-29')).toEqual(
      expect.objectContaining({
        weather_signals: [expect.objectContaining({ signal_type: 'heavy_rain' })],
        calendar_events: [expect.objectContaining({ title: 'Local festival' })],
      })
    );
  });

  it('summarizes department day risk and recommends buffers without auto-publishing', () => {
    const high = scoreStaffLeaveRisk({
      staff: staff({ id: 1 }),
      forecastDates,
      department: 'housekeeping',
      leaveRows: [{
        staff_id: 1,
        leave_status: 'approved',
        start_date: '2026-05-28',
        end_date: '2026-05-28',
      }],
    });
    const medium = scoreStaffLeaveRisk({
      staff: staff({ id: 2 }),
      forecastDates,
      department: 'housekeeping',
      commuteProfile: { id: 2, commute_band: 'long', risk_weight: 12 },
      weatherSignals: [{
        id: 7,
        signal_date: '2026-05-28',
        signal_type: 'heat_alert',
        severity: 'moderate',
        risk_weight: 10,
      }],
    });

    const risks = summarizeShiftRisks({
      scores: [high, medium],
      forecastDates,
      department: 'housekeeping',
    });

    expect(risks[0]).toEqual(
      expect.objectContaining({
        department: 'housekeeping',
        shift_label: 'all',
        predicted_absences: 1,
      })
    );
    expect(risks[0].recommended_buffer_count).toBeGreaterThanOrEqual(1);
    expect(risks[0].source_snapshot).toEqual(
      expect.objectContaining({ known_absences: 1 })
    );
  });
});
