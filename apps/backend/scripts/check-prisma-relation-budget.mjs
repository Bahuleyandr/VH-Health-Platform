import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = resolve(backendRoot, 'prisma', 'schema.prisma');
const schema = readFileSync(schemaPath, 'utf8');

const expectedRelations = [
  'appointments.clinical_notes:clinical_notes',
  'appointments.users_appointments_doctor_idTousers:users',
  'appointments.users_appointments_patient_idTousers:users',
  'beds.wards:wards',
  'clinical_notes.appointments:appointments',
  'doctors.users:users',
  'investigations.users_investigations_patient_idTousers:users',
  'investigations.users_investigations_requested_byTousers:users',
  'invoices.payment_transactions:payment_transactions',
  'medical_records.users_medical_records_doctor_idTousers:users',
  'payment_transactions.invoices:invoices',
  'pharmacy_orders.users_pharmacy_orders_patient_idTousers:users',
  'staff.users:users',
  'users.appointments_appointments_doctor_idTousers:appointments',
  'users.appointments_appointments_patient_idTousers:appointments',
  'users.doctors:doctors',
  'users.investigations_investigations_patient_idTousers:investigations',
  'users.investigations_investigations_requested_byTousers:investigations',
  'users.medical_records_medical_records_doctor_idTousers:medical_records',
  'users.pharmacy_orders_pharmacy_orders_patient_idTousers:pharmacy_orders',
  'users.staff:staff',
  'ward_indent_items.indent:ward_indents',
  'ward_indents.items:ward_indent_items',
  'wards.beds:beds',
].sort();

const modelMatches = [...schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm)];
const modelNames = new Set(modelMatches.map((match) => match[1]));
const modelBodies = new Map(modelMatches.map((match) => [match[1], match[2]]));
const actualRelations = [];

for (const [modelName, body] of modelBodies) {
  for (const line of body.split(/\r?\n/)) {
    const field = line.match(/^\s*(\w+)\s+([A-Za-z_]\w*)(?:\[\]|\?)?(?:\s|$)/);
    if (field && modelNames.has(field[2])) {
      actualRelations.push(`${modelName}.${field[1]}:${field[2]}`);
    }
  }
}

actualRelations.sort();

const missing = expectedRelations.filter((relation) => !actualRelations.includes(relation));
const unexpected = actualRelations.filter((relation) => !expectedRelations.includes(relation));
const datasource = schema.match(/^datasource\s+db\s+\{([\s\S]*?)^\}/m)?.[1] ?? '';
const errors = [];

if (!/^\s*relationMode\s*=\s*"prisma"\s*$/m.test(datasource)) {
  errors.push('datasource db must retain relationMode = "prisma"');
}
if (missing.length > 0) {
  errors.push(`missing curated relation fields: ${missing.join(', ')}`);
}
if (unexpected.length > 0) {
  errors.push(`unexpected relation fields exceed the reviewed compiler budget: ${unexpected.join(', ')}`);
}

const requiredIndexes = new Map([
  ['doctors', '@@index([user_id], map: "idx_doctors_user_id_prisma_relation")'],
  [
    'investigations',
    '@@index([requested_by], map: "idx_investigations_requested_by_prisma_relation")',
  ],
]);

for (const [modelName, index] of requiredIndexes) {
  if (!modelBodies.get(modelName)?.includes(index)) {
    errors.push(`${modelName} must retain ${index}`);
  }
}

if (errors.length > 0) {
  console.error('Prisma relation budget check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  console.error(
    'Database foreign keys remain authoritative. Add Prisma relations only with a confirmed runtime consumer and a successful full client generation.',
  );
  process.exit(1);
}

console.log(`✓ Prisma relation budget: ${actualRelations.length} curated relation fields`);
