// scripts/seed-test-staff-accounts.mjs
//
// Seeds one staff account per StaffRole enum value used by apps/staff (10
// roles total). The seeded password defaults to a deterministic test value and
// can be overridden with VH_TEST_STAFF_PASSWORD. Idempotent — safe to re-run;
// existing accounts get their password and role re-asserted but records are
// not duplicated.
//
//   node --import dotenv/config scripts/seed-test-staff-accounts.mjs
//
// After running, all accounts log in via:
//   POST /api/v1/auth/staff/login
//     { "employeeId": "EMP-100X", "password": "<seed-password>" }
//
// EMP-1001..EMP-1003 are pre-existing e2e_test seeds (Nurse/Pharmacy/Lab).
// EMP-1004..EMP-1021 are added by this script (clinical + support + desk
// roles — see the inline comments on each entry for why it was added).
//
// Note: the staff app's login form regex requires the hyphenated `EMP-NNN`
// format; do NOT switch to `EMP1004`-style or the client won't even POST.

import bcrypt from 'bcrypt';
import prisma from '../src/lib/prisma.js';

const DEFAULT_TEST_STAFF_PASSWORD = ['test', '1234'].join('');
const PASSWORD = process.env.VH_TEST_STAFF_PASSWORD || DEFAULT_TEST_STAFF_PASSWORD;

// One per StaffRole enum value in apps/staff/lib/core/config/role_config.dart.
// EMP-1001..1003 are kept in the table for documentation; this script
// won't insert duplicates because of the existence check.
const ACCOUNTS = [
  { emp: 'EMP-1001', name: 'e2e_test Nurse Arya',      role: 'NURSING_STAFF',  phone: '+919999990001', dept: 'General Medicine',    designation: 'Staff Nurse',     position: 'Staff Nurse' },
  { emp: 'EMP-1002', name: 'e2e_test Pharmacist Bala', role: 'PHARMACY_STAFF', phone: '+919999990002', dept: 'Pharmacy',            designation: 'Pharmacist',      position: 'Pharmacist' },
  { emp: 'EMP-1003', name: 'e2e_test LabTech Chitra',  role: 'LAB_STAFF',      phone: '+919999990003', dept: 'Laboratory',          designation: 'Lab Technician',  position: 'Lab Technician' },
  { emp: 'EMP-1004', name: 'Test Doctor',              role: 'DOCTOR',         phone: '+919999990004', dept: 'General Medicine',    specialty: 'General Medicine',  designation: 'Consultant',      position: 'Consultant' },
  { emp: 'EMP-1005', name: 'Test HR',                  role: 'HR_STAFF',       phone: '+919999990005', dept: 'HR',                  designation: 'HR Officer',      position: 'HR Officer' },
  { emp: 'EMP-1006', name: 'Test Admin',               role: 'ADMIN',          phone: '+919999990006', dept: 'Administration',      designation: 'Administrator',   position: 'Administrator' },
  { emp: 'EMP-1007', name: 'Test Super Admin',         role: 'SUPER_ADMIN',    phone: '+919999990007', dept: 'Administration',      designation: 'Super Admin',     position: 'Super Admin' },
  { emp: 'EMP-1008', name: 'Test General Staff',       role: 'GENERAL_STAFF',  phone: '+919999990008', dept: 'Operations',          designation: 'Staff',           position: 'Staff' },
  // C-4 — RECEPTIONIST seed. Front-desk role with restricted permissions
  // (per userConfig.js: can manage GENERAL_STAFF only, not clinical roles).
  // Walk-in registration is the highest-volume daily workflow at a small
  // hospital — testing as ADMIN masks RECEPTIONIST-specific RBAC failures.
  // Finding: 2026-05-08-walk-in-opd-receptionist-no-receptionist-role-seeded.
  { emp: 'EMP-1009', name: 'Test Receptionist',        role: 'RECEPTIONIST',   phone: '+919999990009', dept: 'Reception',           designation: 'Receptionist',    position: 'Front Desk' },
  // E-13 — OBGYN doctor seed for the obstetric-anc journey. The
  // generic Test Doctor is in General Medicine; the ANC + delivery
  // workflows expect a specialty='Obstetrics' doctor in the roster
  // for the receptionist's department-filtered dropdown.
  // Finding: 2026-05-08-obstetric-anc-receptionist-no-obgyn-doctor-seeded.
  { emp: 'EMP-1010', name: 'Test OBGYN Doctor',        role: 'DOCTOR',         phone: '+919999990010', dept: 'Obstetrics & Gynaecology', specialty: 'Obstetrics',       designation: 'Consultant',      position: 'OBGYN Consultant' },
  // E-13 — Test Pharmacist Incharge for verifying / dispensing
  // medication orders (separate from the EMP-1002 PHARMACY_STAFF
  // role, which represents a regular counter pharmacist).
  { emp: 'EMP-1011', name: 'Test Pharmacy Incharge',   role: 'PHARMACY_INCHARGE', phone: '+919999990011', dept: 'Pharmacy',         designation: 'Pharmacy Incharge', position: 'Pharmacy Incharge' },
  // E-13 — Test paediatrician for paeds-OPD workflow.
  { emp: 'EMP-1012', name: 'Test Paediatrician',       role: 'DOCTOR',         phone: '+919999990012', dept: 'Paediatrics',         specialty: 'Paediatrics', ageRange: 'paediatric', designation: 'Consultant',      position: 'Paediatrician' },
  // E-13 — Test pathologist (signs off lab results — B-3 tier).
  { emp: 'EMP-1013', name: 'Test Pathologist',         role: 'PATHOLOGIST',    phone: '+919999990013', dept: 'Laboratory',          designation: 'Pathologist',     position: 'Lab Director' },
  // E-13 — Test radiologist (signs off radiology reports — E-8 lock).
  { emp: 'EMP-1014', name: 'Test Radiologist',         role: 'RADIOLOGIST',    phone: '+919999990014', dept: 'Radiology',           designation: 'Radiologist',     position: 'Radiology Consultant' },
  // E-13 — Test ICU Nurse (E-4 ICU tier RBAC).
  { emp: 'EMP-1015', name: 'Test ICU Nurse',           role: 'ICU_NURSE',      phone: '+919999990015', dept: 'ICU',                 designation: 'ICU Nurse',       position: 'ICU Nurse' },
  // Stage-5 C-bucket — TPA desk roles. /api/v1/insurance is gated behind
  // ADMIN/SUPER_ADMIN/BILLING_STAFF/INSURANCE_COORDINATOR (app.js); only the
  // admin-tier accounts were seeded, so the TPA/billing journey could only
  // run with admin privileges — masking cashier-vs-finance-vs-TPA scope
  // boundaries. Finding: 2026-05-10-tpa-insurance-claim-billing-no-tpa-role-seed.
  { emp: 'EMP-1016', name: 'Test Billing Staff',       role: 'BILLING_STAFF',         phone: '+919999990016', dept: 'Billing',          designation: 'Billing Executive',     position: 'Cashier' },
  { emp: 'EMP-1017', name: 'Test Insurance Coord',     role: 'INSURANCE_COORDINATOR', phone: '+919999990017', dept: 'Insurance Desk',   designation: 'Insurance Coordinator', position: 'TPA Desk' },
  // Stage-5 C-bucket — admission-counter roles. ADMISSION_OFFICER and
  // IPD_COUNSELLOR appear in app.js route gates (bed-inspections, admission
  // flows) but are absent from the ROLES enum AND unseeded — so admission-
  // counter RBAC could only be tested by borrowing an admin/clinical token,
  // masking counter-role defects. Finding:
  // 2026-05-10-surgical-day-care-admission-no-admission-officer-seed.
  { emp: 'EMP-1018', name: 'Test Admission Officer',   role: 'ADMISSION_OFFICER',     phone: '+919999990018', dept: 'Admissions',       designation: 'Admission Officer',     position: 'Admission Counter' },
  { emp: 'EMP-1019', name: 'Test IPD Counsellor',      role: 'IPD_COUNSELLOR',        phone: '+919999990019', dept: 'Admissions',       designation: 'IPD Counsellor',        position: 'IPD Counsellor' },
  // Housekeeping and maintenance are intentionally separate from
  // GENERAL_STAFF. Housekeeping closes bed-cleaning turnover; maintenance
  // handles facilities/electrical work and must not inherit the bed-ready
  // permission by accident.
  { emp: 'EMP-1020', name: 'Test Housekeeping Staff',   role: 'HOUSEKEEPING_STAFF',    phone: '+919999990020', dept: 'Housekeeping',     designation: 'Housekeeping Staff',    position: 'Housekeeping' },
  { emp: 'EMP-1021', name: 'Test Maintenance Staff',    role: 'MAINTENANCE',           phone: '+919999990021', dept: 'Maintenance',      designation: 'Electrician',           position: 'Maintenance Technician' },
];

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);

  const summary = [];
  for (const acc of ACCOUNTS) {
    // Wrap each account's lookup + upsert in a transaction so a concurrent
    // run can't get two halves of the work in via interleaved statements
    // (e.g. find no user → other run inserts → this run inserts → UNIQUE
    // violation on phone). The whole "ensure exactly one user + one staff
    // row for this employee" thing rolls back as a unit on conflict.
    const action = await prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT u.uid, u.id, u.role
         FROM users u
         LEFT JOIN staff s ON s.user_id = u.uid
         WHERE s.employee_id = $1 OR u.phone = $2
         LIMIT 1`,
        acc.emp, acc.phone
      );

      let uid;
      let userId;
      let didInsert = false;
      if (existing.length) {
        uid = existing[0].uid;
        userId = existing[0].id;
        await tx.$executeRawUnsafe(
          `UPDATE users
              SET role = $1,
                  encrypted_password = $2,
                  name = COALESCE(NULLIF(name, ''), $3),
                  phone = $4,
                  is_active = TRUE,
                  status = 'active',
                  updated_at = NOW()
            WHERE uid = $5::uuid`,
          acc.role, hash, acc.name, acc.phone, uid
        );
      } else {
        const inserted = await tx.$queryRawUnsafe(
          `INSERT INTO users
             (uid, phone, name, role, encrypted_password, is_active, status, registered_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, TRUE, 'active', NOW(), NOW())
           RETURNING uid, id`,
          acc.phone, acc.name, acc.role, hash
        );
        uid = inserted[0].uid;
        userId = inserted[0].id;
        didInsert = true;
      }

      const staffExists = await tx.$queryRawUnsafe(
        `SELECT id FROM staff WHERE employee_id = $1 OR user_id = $2::uuid LIMIT 1`,
        acc.emp, uid
      );
      if (staffExists.length === 0) {
        await tx.$executeRawUnsafe(
          `INSERT INTO staff
             (user_id, employee_id, name, designation, position, department, is_active, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())`,
          uid, acc.emp, acc.name, acc.designation, acc.position, acc.dept
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE staff
              SET employee_id = $1,
                  name = $2,
                  designation = $3,
                  position = $4,
                  department = $5,
                  is_active = TRUE,
                  updated_at = NOW()
            WHERE id = $6`,
          acc.emp, acc.name, acc.designation, acc.position, acc.dept, staffExists[0].id
        );
      }

      if (acc.role === 'DOCTOR') {
        const specialty = acc.specialty || acc.dept;
        const ageRange = acc.ageRange || 'all';
        const doctorExists = await tx.$queryRawUnsafe(
          `SELECT id FROM doctors WHERE user_id = $1 LIMIT 1`,
          userId
        );
        if (doctorExists.length === 0) {
          await tx.$executeRawUnsafe(
            `INSERT INTO doctors
               (user_id, name, department, specialty, age_range, is_available, is_active, updated_at)
             VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, NOW())`,
            userId, acc.name, acc.dept, specialty, ageRange
          );
        } else {
          await tx.$executeRawUnsafe(
            `UPDATE doctors
                SET name = $1,
                    department = $2,
                    specialty = $3,
                    age_range = $4,
                    is_available = TRUE,
                    is_active = TRUE,
                    updated_at = NOW()
              WHERE id = $5`,
            acc.name, acc.dept, specialty, ageRange, doctorExists[0].id
          );
        }
      }
      return didInsert ? 'inserted' : 'updated';
    });
    summary.push({ emp: acc.emp, role: acc.role, action });
  }

  console.log('\n┌──────────┬─────────────────┬──────────┐');
  console.log('│ Employee │ Role            │ Action   │');
  console.log('├──────────┼─────────────────┼──────────┤');
  for (const r of summary) {
    console.log(`│ ${r.emp.padEnd(8)} │ ${r.role.padEnd(15)} │ ${r.action.padEnd(8)} │`);
  }
  console.log('└──────────┴─────────────────┴──────────┘');
  console.log(`\nAll accounts use password: ${PASSWORD}`);
  console.log('Login via: POST /api/v1/auth/staff/login { employeeId, password }\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async err => {
    console.error('Seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
