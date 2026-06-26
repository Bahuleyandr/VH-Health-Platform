// Value-TDD regression for the payroll leave money bug.
//
// calculatePayslip()'s "approved leaves this month" sub-query queried
// leave_applications with WRONG columns (from_date/to_date, a non-existent
// staff_uid) so the query always threw 42703 and the catch returned the WRONG
// SHAPE ({ rows: [...] } vs the array $queryRawUnsafe yields) — leaveDays was
// ALWAYS 0. That under-pays staff twice:
//   • effectiveDays = min(daysPresent + leaveDays, 26) → lower attendance factor,
//   • daysAbsent = max(0, 26 - daysPresent - leaveDays) → a WRONGFUL LOP deduction
// because approved leave is silently treated as unpaid absence.
//
// This test seeds a GENERAL_STAFF user, a staff_salary config, and ONE APPROVED
// leave_applications row spanning a KNOWN number of calendar days fully inside a
// target month (no attendance → daysPresent 0), then calls calculatePayslip
// DIRECTLY and asserts days_leave === the seeded count (RED = 0 before the fix).
//
// Modelled on discharge-summary-autofill-deep.test.js (direct-prisma fixtures +
// cleanup). Default tenant; unique uid/phone prefixes so it never collides.

import prisma from '../lib/prisma.js';
import { calculatePayslip } from '../services/staff/payrollService.js';

const STAFF_UID = 'b0700001-0001-4d00-8d00-b07000000001'; // GENERAL_STAFF: salary + approved leave
const STAFF_PHONE = '9507000001';

// Far-future month/year so no attendance / other-suite payroll rows collide.
const LEAVE_MONTH = 7; // July
const LEAVE_YEAR = 2097;
// Approved leave fully inside the month: 2097-07-10 .. 2097-07-12 inclusive = 3 days.
const LEAVE_START = `${LEAVE_YEAR}-07-10`;
const LEAVE_END = `${LEAVE_YEAR}-07-12`;
const EXPECTED_LEAVE_DAYS = 3;

const BASIC_SALARY = 26000; // /26 = 1000/day → clean LOP arithmetic

async function cleanup() {
  // leave_applications.staff_id → users.id; delete by the bridged id (and by our
  // uid as a belt-and-braces guard in case of partial seeds).
  await prisma.$executeRawUnsafe(
    `DELETE FROM leave_applications
       WHERE staff_id = (SELECT id FROM users WHERE uid = $1::uuid)`,
    STAFF_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff_salary WHERE staff_uid = $1::uuid`,
    STAFF_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM payslips WHERE staff_uid = $1::uuid`,
    STAFF_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = $1::uuid`,
    STAFF_UID,
  ).catch(() => {});
}

describe('payroll calculatePayslip — approved leave is counted (not silently 0)', () => {
  beforeAll(async () => {
    await cleanup();
    // Staff user (role GENERAL_STAFF) — gives us a known users.id via uid.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Payroll Leave Staff', 'GENERAL_STAFF', true, NOW())`,
      STAFF_UID,
      STAFF_PHONE,
    );

    // Salary config — calculatePayslip requires an active staff_salary row.
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_salary
         (staff_uid, basic_salary, hra_pct, da_pct, special_allowance,
          transport_allowance, medical_allowance, pf_employee_pct,
          esi_applicable, tds_monthly, is_active)
       VALUES ($1::uuid, $2, 40, 10, 0, 0, 0, 12, false, 0, true)`,
      STAFF_UID,
      BASIC_SALARY,
    );

    // ONE approved leave fully inside the target month (3 calendar days).
    // staff_id is the FK to users.id — bridge from our uid.
    await prisma.$executeRawUnsafe(
      `INSERT INTO leave_applications
         (staff_id, leave_type, start_date, end_date, status, applied_date, created_at)
       VALUES ((SELECT id FROM users WHERE uid = $1::uuid),
               'casual', $2::date, $3::date, 'approved', NOW(), NOW())`,
      STAFF_UID,
      LEAVE_START,
      LEAVE_END,
    );
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60000);

  it('counts the 3 approved-leave days and excludes them from absence/LOP', async () => {
    const slip = await calculatePayslip(STAFF_UID, LEAVE_MONTH, LEAVE_YEAR);

    // ── RED assertion: before the fix this is 0 (the query throws + the catch
    //    returns the wrong shape) — after the fix it is the seeded 3.
    expect(slip.days_leave).toBe(EXPECTED_LEAVE_DAYS);

    // No attendance was seeded → daysPresent is 0. Absence must be REDUCED by the
    // approved leave: 26 - 0 - 3 = 23 (not 26 - 0 = 26).
    expect(slip.days_present).toBe(0);
    expect(slip.days_absent).toBe(26 - 0 - EXPECTED_LEAVE_DAYS);

    // LOP must EXCLUDE the approved leave. lop_days mirrors days_absent (23), and
    // basic/26 = 1000/day → lop_deduction = 23 * 1000 = 23000 (NOT 26000, which is
    // what a full-month wrongful LOP would deduct).
    expect(slip.lop_days).toBe(26 - 0 - EXPECTED_LEAVE_DAYS);
    expect(slip.lop_deduction).toBe(23000);

    // Earnings reflect leave as PAID: effectiveDays = min(0 + 3, 26) = 3, so the
    // attendance factor is 3/26 — strictly greater than the 0/26 a silently-zeroed
    // leaveDays would have produced. basic_earned = 26000 * 3/26 = 3000.
    expect(slip.basic_earned).toBe(3000);
    expect(slip.attendance_factor).toBe(Math.round((3 / 26) * 100) / 100);
  });
});
