import { parse } from 'espree';
import path from 'node:path';

const site = (module, file, symbol, match, access, auditLine) => ({
  module, file: `apps/backend/src/${file}`, symbol, match, access, auditLine,
});
const housekeeping = 'controllers/staff/housekeepingController.js';
const investigations = 'controllers/investigation/investigationController.js';
const appointments = 'controllers/appointment/appointmentWorkflowController.js';

export const CONFIRMED_SITES = [
  site('T1-A housekeeping', housekeeping, 'verifyLog', /UPDATE housekeeping_logs/i, 'W', 1155),
  site('T1-A housekeeping', housekeeping, 'endFloorAssignment', /UPDATE housekeeping_floor_assignments/i, 'W', 1038),
  site('T1-A housekeeping', housekeeping, 'deleteZone', /UPDATE housekeeping_zones/i, 'W', 1460),
  site('T1-A housekeeping', housekeeping, 'getAllCleaningLogs', /FROM housekeeping_logs/i, 'R', 678),
  site('T1-A housekeeping', housekeeping, 'getHousekeepingStats', /as completions/i, 'R', 1275),
  site('T1-B investigations', investigations, 'getInvestigationsByUID', /\b(?:FROM users|FROM investigations)\b/i, 'R', 455),
  site('T1-B investigations', investigations, 'getInvestigationSLADashboard', /as tat_hours/i, 'R', 601),
  site('T1-B investigations', investigations, 'getInvestigationSLADashboard', /SELECT (?:COUNT\(\*\)|status, COUNT|priority, COUNT)/i, 'R', 574),
  site('T1-B investigations', 'controllers/investigation/bookingController.js', 'getBookingQueue', /FROM investigation_bookings/i, 'R', 450),
  site('T1-C appointments', appointments, 'getTodayQueue', /FROM (?:appointments|emergency_visits)/i, 'R', 995),
  site('T1-C appointments', appointments, 'getDoctorOptions', /FROM doctors/i, 'R', 197),
  site('T1-C appointments', appointments, 'getAvailableSlots', /FROM (?:doctors|appointments)/i, 'R', 1152),
  site('T1-C appointments', 'controllers/doctor/adminDoctorController.js', 'updateDoctorProfile', /UPDATE users/i, 'W', 188),
  site('T1-D staff-admin', 'controllers/staff/staffAdminHRController.js', 'approvePerformanceReview', /UPDATE staff_performance_reviews/i, 'W', 70),
  site('T1-D staff-admin', 'controllers/staff/staffAdminLeaveController.js', 'bulkLeaveApproval', /UPDATE leave_applications/i, 'W', 85),
  site('T1-D staff-admin', 'controllers/staff/staffAdminDashboardController.js', 'getStaffAdminDashboard', /'attendance' as type/i, 'R', 50),
  site('T1-D staff-admin', 'controllers/staff/reportAuditController.js', 'getReportAuditTrail', /FROM (?:incident_reports|staff_grievances|report_updates)/i, 'R', 180),
  site('T1-E wards-consent-roster-rx', 'services/bed/bedService.js', 'updateWard', /UPDATE wards/i, 'W', 312),
  site('T1-E wards-consent-roster-rx', 'services/bed/bedService.js', 'deleteWard', /DELETE FROM wards/i, 'W', 384),
  site('T1-E wards-consent-roster-rx', 'routes/consentRoutes.js', 'PATCH /data-rights/:id', /UPDATE patient_data_rights_requests/i, 'W', 405),
  site('T1-E wards-consent-roster-rx', 'services/staff/rosterBoardService.js', 'resolveRosterStaff', /FROM users/i, 'R', 544),
  site('T1-E wards-consent-roster-rx', 'controllers/prescription/ePrescriptionController.js', 'getPrescription', /FROM e_prescriptions/i, 'R', 2476),
];

function walk(node, visit) {
  if (!node || typeof node !== 'object') { return; }
  if (typeof node.type === 'string') { visit(node); }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) { walk(child, visit); }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

const propertyName = (node) => node?.name ?? node?.value;
const parseSource = (source) => parse(source, {
  ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true,
});

function sqlText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') { return node.value; }
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map((part) => part.value.cooked ?? part.value.raw).join(' __dynamic__ ');
  }
  return null;
}

export function tableReferences(sql, writeOnly = false) {
  const text = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const verbs = writeOnly ? 'INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|MERGE\\s+INTO' :
    'FROM|JOIN|UPDATE|INSERT\\s+INTO|MERGE\\s+INTO';
  const identifier = '(?:"[^"]+"|[a-z_][a-z_0-9]*)';
  const pattern = new RegExp(`\\b(?:${verbs})\\s+(?:ONLY\\s+)?(${identifier})(?:\\s*\\.\\s*(${identifier}))?`, 'gi');
  const found = [];
  for (const match of text.matchAll(pattern)) {
    const schema = match[2] ? match[1].replaceAll('"', '') : 'public';
    const table = (match[2] || match[1]).replaceAll('"', '');
    if (table !== '__dynamic__') { found.push(`${schema}.${table}`); }
  }
  return [...new Set(found)].sort();
}

export function relocateSites(sources, definitions = CONFIRMED_SITES, relationNames = null) {
  return definitions.map((definition) => {
    const source = sources.get(definition.file);
    if (source == null) { throw new Error(`Missing audit source: ${definition.file}`); }
    const scopes = [];
    walk(parseSource(source), (node) => {
      if (node.type === 'FunctionDeclaration' && node.id?.name === definition.symbol) { scopes.push(node); }
      if (node.type === 'VariableDeclarator' && node.id?.name === definition.symbol) { scopes.push(node); }
      if (['Property', 'MethodDefinition'].includes(node.type) && propertyName(node.key) === definition.symbol) { scopes.push(node); }
      if (definition.symbol === 'PATCH /data-rights/:id' && node.type === 'CallExpression' &&
          propertyName(node.callee?.property) === 'patch' && node.arguments[0]?.value === '/data-rights/:id') {
        scopes.push(node);
      }
    });
    if (scopes.length !== 1) { throw new Error(`Expected one symbol ${definition.file}:${definition.symbol}; found ${scopes.length}`); }
    const statements = [];
    walk(scopes[0], (node) => {
      const text = sqlText(node);
      if (text && definition.match.test(text)) {
        statements.push({ line: node.loc.start.line, tables: tableReferences(text) });
      }
    });
    if (!statements.length) { throw new Error(`No audit statement in ${definition.file}:${definition.symbol}`); }
    return {
      ...definition, match: undefined, line: scopes[0].loc.start.line,
      statementLines: [...new Set(statements.map((statement) => statement.line))],
      tables: [...new Set(statements.flatMap((statement) => statement.tables))]
        .filter((table) => !relationNames || relationNames.has(table)).sort(),
    };
  });
}

export function scanWriters(sources, modelTables = new Map()) {
  const writers = new Map();
  const add = (table, file, line, kind) => {
    const entries = writers.get(table) || [];
    if (!entries.some((entry) => entry.file === file && entry.line === line && entry.kind === kind)) {
      entries.push({ file, line, kind, module: path.posix.dirname(file) });
    }
    writers.set(table, entries);
  };
  for (const [file, source] of sources) {
    walk(parseSource(source), (node) => {
      const sql = sqlText(node);
      if (sql) {
        for (const table of tableReferences(sql, true)) { add(table, file, node.loc.start.line, 'SQL'); }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
          /^(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)$/.test(propertyName(node.callee.property))) {
        const model = propertyName(node.callee.object?.property);
        if (modelTables.has(model)) { add(modelTables.get(model), file, node.loc.start.line, 'model delegate'); }
      }
    });
  }
  return writers;
}

export function parseModelTables(schema) {
  const models = new Map();
  for (const match of schema.matchAll(/\bmodel\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const table = match[2].match(/@@map\("([^"]+)"\)/)?.[1] || match[1];
    const namespace = match[2].match(/@@schema\("([^"]+)"\)/)?.[1] || 'public';
    models.set(match[1][0].toLowerCase() + match[1].slice(1), `${namespace}.${table}`);
  }
  return models;
}

export function owningModule(writers) {
  const services = writers.filter((writer) => writer.file.includes('/src/services/'));
  const handlers = writers.filter((writer) => /\/src\/(?:controllers|routes)\//.test(writer.file));
  const candidates = services.length ? services : handlers.length ? handlers : writers;
  const modules = [...new Set(candidates.map((writer) => writer.module))].sort();
  return modules.length ? modules.join(' + ') : 'UNASSIGNED — no static writer located';
}
