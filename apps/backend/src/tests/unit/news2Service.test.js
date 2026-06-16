import { jest } from '@jest/globals';

// news2Service imports prisma/logger/notificationOutbox at load; mock them so the
// pure calculateNEWS2/getClinicalRisk can be exercised DB-free.
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: { $queryRawUnsafe: jest.fn() } }));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({ default: { queue: jest.fn() } }));

const { calculateNEWS2, getClinicalRisk } = await import('../../services/clinical/news2Service.js');

const NORMAL = { respiration_rate: 16, spo2: 98, temperature: 37, systolic_bp: 120, heart_rate: 72, consciousness: 'A' };

test('calculateNEWS2 reports anyParamThree=true when a single parameter scores 3', () => {
  const r = calculateNEWS2({ ...NORMAL, respiration_rate: 26 }); // RR>=25 -> 3
  expect(r.anyParamThree).toBe(true);
  expect(r.totalScore).toBe(3);
});

test('calculateNEWS2 reports anyParamThree=false when no single parameter scores 3', () => {
  const r = calculateNEWS2({ ...NORMAL, respiration_rate: 22, heart_rate: 95 }); // 2 + 1 = 3 aggregate, no single 3
  expect(r.anyParamThree).toBe(false);
  expect(r.totalScore).toBe(3);
});

test('getClinicalRisk honors the single-parameter-3 urgent-review rule at low aggregate', () => {
  const withParam3 = getClinicalRisk(3, { anyParamThree: true });
  expect(withParam3.clinicalRisk).toBe('low_to_medium');
  expect(withParam3.escalationAction).toMatch(/single NEWS2 parameter scored 3/i);
  // backward-compatible default:
  const plain = getClinicalRisk(3);
  expect(plain.clinicalRisk).toBe('low_to_medium');
  expect(plain.escalationAction).toMatch(/registered nurse/i);
});

test('getClinicalRisk aggregate bands unchanged', () => {
  expect(getClinicalRisk(7).clinicalRisk).toBe('high');
  expect(getClinicalRisk(5).clinicalRisk).toBe('medium');
  expect(getClinicalRisk(0).clinicalRisk).toBe('low');
});
