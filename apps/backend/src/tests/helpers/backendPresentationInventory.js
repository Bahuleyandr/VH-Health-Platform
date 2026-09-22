import { createHash } from 'node:crypto';
import { parse } from 'espree';
import {
  DISPATCH_ENTRY_POINTS,
  MECHANISM_PATTERNS,
  ORM_METHOD_EFFECTS,
  walkSources,
} from './notificationSourceScan.js';

export const FIVE_LOCALES = Object.freeze(['en', 'hi', 'ta', 'te', 'ml']);
export const DISCOVERY_SCOPE = Object.freeze({
  source: 'Production .js files under apps/backend/src, using notificationSourceScan.walkSources',
  mechanisms: [
    'Literal locale-key objects and named *_PRESENTATIONS declarations',
    'Objects with title plus body/message/description, or title_template/message_template',
    'Named template containers and render*Sms/Notification/Template/Email functions',
    'action_label_key properties and explicit locale/language settings',
    'Notification calls, notifications ORM writes, and literal inbox/outbox INSERT statements',
  ],
  limits: [
    'Syntactic source candidates, not proof of execution, recipient reachability or translation approval',
    'No database-authored content, provider language support or human approval evidence is inspected',
    'No general endpoint-error, email HTML, document prose or arbitrary string census',
    'Indirect/computed custom transport wrappers and dynamically assembled SQL may need additional discovery mechanisms',
    'Locale-key maps are structural candidates; isolated unit keys mixed with non-locale fields are not treated as language maps',
    'General language allowlists, resolver branches and imported/spread locale matrices need separately supported analysis',
    'Non-JavaScript sources and the maintained walker exclusions are not scanned',
  ],
});

export const INVENTORY_GATE = 'backendPresentationInventory.test.js: source census has exact two-way held accounting';

const LANGUAGE_KEYS = new Set([
  'locale', 'language', 'preferred_language', 'preferredLanguage', 'voiceLanguage',
  'targetLanguage', 'target_language', 'language_code', 'languageCode', 'target_lang',
]);
const DIRECT_TRANSPORTS = new Set([
  'sendPushNotification', ...DISPATCH_ENTRY_POINTS, 'sendSMS', 'sendEmail',
  'sendWhatsApp', 'placeVoiceCall', 'queuePatientSms', 'queueClinicalAlertFanout',
  'queueAppointmentConfirmationSms', 'queueAppointmentRescheduleSms', 'queueAppointmentReminderSms',
  'recordPatientFeedNotification', 'recordPatientFeedNotificationWithReceipt',
]);
const OMIT_AST_KEYS = new Set(['loc', 'range', 'raw', 'start', 'end']);
const CATEGORIES = Object.freeze({
  'locale-matrix': 'static-locale-matrix-pending-review',
  'frozen-locale-matrix': 'shared-frozen-copy-pending-review',
  'scalar-locale-map': 'scalar-locale-values-pending-contract-review',
  'presentation-object': 'presentation-candidate-pending-content-review',
  'template-container': 'template-container-pending-content-review',
  'text-renderer': 'text-renderer-pending-content-review',
  'action-label': 'client-action-key-pending-consumer-review',
  'locale-setting': 'locale-setting-pending-consumer-trace',
  transport: 'transport-payload-pending-presentation-trace',
  'sql-notification-write': 'stored-notification-pending-presentation-trace',
  'orm-notification-write': 'stored-notification-pending-presentation-trace',
});

function children(node) {
  return Object.entries(node).flatMap(([key, value]) => {
    if (OMIT_AST_KEYS.has(key)) { return []; }
    if (Array.isArray(value)) { return value.filter(child => child?.type); }
    return value?.type ? [value] : [];
  });
}

function propertyName(node) {
  if (!node) { return null; }
  if (node.type === 'Identifier') { return node.name; }
  if (node.type === 'Literal' && typeof node.value === 'string') { return node.value; }
  return null;
}

function memberName(node) {
  if (node?.type === 'ChainExpression') { return memberName(node.expression); }
  if (node?.type === 'Identifier') { return node.name; }
  if (node?.type !== 'MemberExpression') { return null; }
  return node.computed && node.property.type !== 'Literal' ? null : propertyName(node.property);
}

function canonical(node) {
  return JSON.stringify(node, (key, value) => {
    if (OMIT_AST_KEYS.has(key)) { return undefined; }
    if (typeof value === 'bigint') { return `${value}n`; }
    return value;
  });
}

function scopesFor(ast) {
  const scopes = new WeakMap();
  function bindUnknown(pattern, scope) {
    if (!pattern) { return; }
    if (pattern.type === 'Identifier') { scope.bindings.set(pattern.name, null); }
    if (pattern.type === 'AssignmentPattern') { bindUnknown(pattern.left, scope); }
    if (pattern.type === 'RestElement') { bindUnknown(pattern.argument, scope); }
    if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) { bindUnknown(element, scope); }
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) { bindUnknown(property.value || property.argument, scope); }
    }
  }
  function visit(node, outer) {
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id && outer) {
      outer.bindings.set(node.id.name, null);
    }
    const isClass = ['ClassDeclaration', 'ClassExpression'].includes(node.type);
    const opens = ['Program', 'BlockStatement', 'StaticBlock', 'CatchClause', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'SwitchStatement'].includes(node.type)
      || isClass || /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type);
    const functionBoundary = ['Program', 'StaticBlock'].includes(node.type) || /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type);
    const scope = opens ? { parent: outer, bindings: new Map(), functionBoundary } : outer;
    scopes.set(node, scope);
    for (const param of node.params || []) { bindUnknown(param, scope); }
    if (node.type === 'FunctionExpression' || isClass) { bindUnknown(node.id, scope); }
    if (node.type === 'CatchClause') { bindUnknown(node.param, scope); }
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers) { bindUnknown(specifier.local, scope); }
    }
    if (node.type === 'VariableDeclaration') {
      let bindingScope = scope;
      if (node.kind === 'var') {
        while (!bindingScope.functionBoundary) { bindingScope = bindingScope.parent; }
      }
      for (const declaration of node.declarations) {
        if (declaration.id.type === 'Identifier') {
          bindingScope.bindings.set(declaration.id.name, node.kind === 'const' ? declaration.init : null);
        } else { bindUnknown(declaration.id, bindingScope); }
      }
    }
    for (const child of children(node)) { visit(child, scope); }
  }
  visit(ast, null);
  return scopes;
}

function staticValue(node, scopes, seen = new Set()) {
  if (!node || seen.has(node)) { throw new Error('unresolved or cyclic static locale value'); }
  const next = new Set(seen).add(node);
  if (node.type === 'Identifier') {
    let scope = scopes.get(node);
    while (scope && !scope.bindings.has(node.name)) { scope = scope.parent; }
    if (!scope || !scope.bindings.get(node.name)) { throw new Error(`unresolved locale alias ${node.name}`); }
    return staticValue(scope.bindings.get(node.name), scopes, next);
  }
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.name === 'Object' && memberName(node.callee) === 'freeze'
      && node.arguments.length === 1) {
    let scope = scopes.get(node);
    while (scope) {
      if (scope.bindings.has('Object')) { throw new Error('shadowed Object.freeze is not a static locale wrapper'); }
      scope = scope.parent;
    }
    return staticValue(node.arguments[0], scopes, next);
  }
  if (node.type === 'Literal' && typeof node.value === 'string') { return node.value; }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  if (node.type !== 'ObjectExpression') { throw new Error(`unsupported static locale expression ${node.type}`); }
  const result = {};
  for (const property of node.properties) {
    const key = propertyName(property.key);
    if (property.type !== 'Property' || property.method || property.kind !== 'init'
        || !key || (property.computed && property.key.type !== 'Literal')) {
      throw new Error('unsupported spread, computed key or accessor in locale object');
    }
    if (key === '__proto__' && !property.computed && !property.shorthand) {
      throw new Error('unsupported prototype setter in locale object');
    }
    if (Object.hasOwn(result, key)) { throw new Error(`duplicate locale/field ${key}`); }
    Object.defineProperty(result, key, { value: staticValue(property.value, scopes, next), enumerable: true });
  }
  return result;
}

function placeholders(text) {
  const pattern = /\$\{\s*[A-Za-z_][\w.]*\s*\}|\{\{\s*[A-Za-z_][\w.]*\s*\}\}|\{\s*[A-Za-z_][\w.]*\s*\}|%%|%(?:\d+\$)?[A-Za-z]/g;
  const named = [];
  const positional = [];
  for (const [token] of text.matchAll(pattern)) {
    if (token === '%%') { continue; }
    if (token.startsWith('%') && !/^%(?:\d+\$)?[sdif]$/.test(token)) {
      throw new Error(`unsupported placeholder format ${token}`);
    }
    if (/^%[sdif]$/.test(token)) { positional.push(token); }
    else { named.push(token.replace(/\s/g, '')); }
  }
  if (/[{}]/.test(text.replace(pattern, ''))) { throw new Error('unsupported or malformed placeholder braces'); }
  return { named: named.sort(), positional };
}

function inspectLocaleMap(value) {
  const locales = Object.keys(value).sort();
  if (!FIVE_LOCALES.every(locale => locales.includes(locale))) {
    throw new Error(`missing required locale: found ${locales.join(',')}`);
  }
  if (Object.values(value).every(item => typeof item === 'string' && item.trim())) {
    for (const locale of locales) {
      if (JSON.stringify(placeholders(value[locale])) !== JSON.stringify(placeholders(value.en))) {
        throw new Error(`placeholder mismatch ${locale}`);
      }
    }
    return { kind: 'scalar-locale-map', locales, fields: [] };
  }
  if (JSON.stringify(locales) !== JSON.stringify([...FIVE_LOCALES].sort())) {
    throw new Error('presentation matrices require exactly five locales');
  }
  const fields = Object.keys(value.en).sort();
  if (!fields.length) { throw new Error('empty locale presentation'); }
  for (const locale of FIVE_LOCALES) {
    const item = value[locale];
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(fields)) {
      throw new Error(`inconsistent fields for ${locale}`);
    }
    for (const field of fields) {
      if (typeof item[field] !== 'string' || !item[field].trim()) {
        throw new Error(`empty/non-string presentation ${locale}.${field}`);
      }
      if (JSON.stringify(placeholders(item[field])) !== JSON.stringify(placeholders(value.en[field]))) {
        throw new Error(`placeholder mismatch ${locale}.${field}`);
      }
    }
  }
  const frozen = FIVE_LOCALES.every(locale => fields.every(field => value[locale][field] === value.en[field]));
  return { kind: frozen ? 'frozen-locale-matrix' : 'locale-matrix', locales, fields };
}

function isUnitProperty(property) {
  return propertyName(property.key) === 'ml' && property.value?.type === 'ObjectExpression'
    && property.value.properties.some(field => propertyName(field.key) === 'dim')
    && property.value.properties.some(field => propertyName(field.key) === 'factor');
}

export function scanBackendPresentations(sources) {
  if (Object.keys(MECHANISM_PATTERNS).sort().join(',') !== 'push,queue,raw,rowInsert') {
    throw new Error('maintained notification scanner has a mechanism requiring inventory support');
  }
  const inputs = sources || [];
  if (!sources) { walkSources((file, source) => inputs.push({ file, source })); }
  if (!inputs.length) { throw new Error('empty production source discovery'); }
  const sites = [];
  const fileNames = new Set();
  for (const { file, source } of inputs) {
    if (!file || fileNames.has(file)) { throw new Error(`duplicate/empty source path ${file}`); }
    fileNames.add(file);
    let ast;
    try {
      ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
    } catch (error) { throw new Error(`${file}: parse failure: ${error.message}`); }
    const scopes = scopesFor(ast);
    const occurrences = new Map();
    const matrixNodes = new Set();
    let owner = 'module';
    function record(node, kind, detail = {}) {
      const identity = { owner, node };
      if (detail.contentDigest) { identity.contentDigest = detail.contentDigest; }
      const digest = createHash('sha256').update(canonical(identity)).digest('hex');
      const stem = `${file}#${kind}:${digest}`;
      const occurrence = (occurrences.get(stem) || 0) + 1;
      occurrences.set(stem, occurrence);
      sites.push({ id: `${stem}:${occurrence}`, file, line: node.loc.start.line, owner, kind,
        category: CATEGORIES[kind], ...detail });
    }
    function matrix(node) {
      const expression = node;
      while (node?.type === 'CallExpression' && node.callee.type === 'MemberExpression'
          && node.callee.object.name === 'Object' && memberName(node.callee) === 'freeze'
          && node.arguments.length === 1) {
        node = node.arguments[0];
      }
      if (matrixNodes.has(node)) { return; }
      matrixNodes.add(node);
      try {
        const value = staticValue(expression, scopes);
        const detail = inspectLocaleMap(value);
        record(node, detail.kind, { ...detail,
          contentDigest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        });
      } catch (error) { throw new Error(`${file}:${node?.loc.start.line || 1}: ${error.message}`); }
    }
    function visit(node, context = 'module') {
      owner = node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
        ? `${context}/${node.id.name}`
        : node.type === 'FunctionDeclaration' && node.id ? `${context}/${node.id.name}` : context;
      const currentOwner = owner;
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
          && /_PRESENTATIONS$/.test(node.id.name)) {
        matrix(node.init);
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
          && /(?:TEMPLATES|Templates)$/.test(node.id.name)) {
        record(node, 'template-container');
      }
      const rendererName = ['FunctionDeclaration', 'VariableDeclarator'].includes(node.type) ? node.id?.name
        : ['MethodDefinition', 'Property'].includes(node.type) && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value?.type)
          ? propertyName(node.key) : null;
      if (/^render.*(?:Sms|SMS|Notification|Template|Email)/.test(rendererName || '')) {
        record(node, 'text-renderer');
      }
      if (node.type === 'ObjectExpression') {
        const properties = node.properties.filter(property => property.type === 'Property');
        const keys = properties.map(property => propertyName(property.key));
        const localeProperties = properties.filter(property => FIVE_LOCALES.includes(propertyName(property.key)));
        const localeShape = localeProperties.length >= 2
          || (localeProperties.length > 0 && localeProperties.length === node.properties.length);
        if (localeShape && !localeProperties.every(isUnitProperty)) { matrix(node); }
        if ((keys.includes('title') && keys.some(key => ['body', 'message', 'description'].includes(key)))
            || keys.includes('title_template') || keys.includes('message_template')) {
          record(node, 'presentation-object', { fields: keys.filter(Boolean).sort() });
        }
      }
      if (node.type === 'Property') {
        const key = propertyName(node.key);
        if (key === 'action_label_key') { record(node, 'action-label'); }
        if (LANGUAGE_KEYS.has(key)) { record(node, 'locale-setting', { field: key }); }
      }
      if (node.type === 'AssignmentPattern' && LANGUAGE_KEYS.has(node.left.name)) {
        record(node, 'locale-setting', { field: node.left.name });
      }
      if (node.type === 'CallExpression') {
        const name = memberName(node.callee);
        if (DIRECT_TRANSPORTS.has(name) || name === 'queue') {
          record(node, 'transport', { mechanism: name });
        }
        if (node.callee.type === 'MemberExpression' && memberName(node.callee.object) === 'notifications') {
          const effect = ORM_METHOD_EFFECTS[name];
          if (!['creates', 'retypes', 'inert', 'not-prisma'].includes(effect)) {
            throw new Error(`${file}:${node.loc.start.line}: unclassified notifications ORM method ${name}`);
          }
          if (effect === 'creates' || effect === 'retypes') {
            record(node, 'orm-notification-write', { mechanism: name });
          }
        }
      }
      const sql = node.type === 'TemplateLiteral' ? node.quasis.map(part => part.value.raw).join(' ')
        : node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
      if (sql) {
        for (const mechanism of ['raw', 'rowInsert']) {
          const pattern = MECHANISM_PATTERNS[mechanism];
          const hits = [...sql.matchAll(new RegExp(pattern.source, pattern.flags))];
          for (const hit of hits) { record(node, 'sql-notification-write', { mechanism, statement: hit[0].toLowerCase() }); }
        }
      }
      for (const child of children(node)) { visit(child, currentOwner); }
    }
    visit(ast);
  }
  if (!sites.length) { throw new Error('empty presentation candidate discovery'); }
  return sites.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function validatePresentationInventory(sites, inventory) {
  if (!sites.length || !inventory?.entries?.length) { throw new Error('empty presentation inventory'); }
  if (inventory.schemaVersion !== 1 || canonical(inventory.scope) !== canonical(DISCOVERY_SCOPE)
      || Object.keys(inventory).sort().join(',') !== 'entries,schemaVersion,scope') {
    throw new Error('inventory schema/discovery scope mismatch');
  }
  const found = new Map(sites.map(site => [site.id, site]));
  if (found.size !== sites.length) { throw new Error('duplicate discovered identity'); }
  const registered = new Set();
  for (const entry of inventory.entries) {
    if (typeof entry.id !== 'string' || /[*?]/.test(entry.id) || registered.has(entry.id)) {
      throw new Error(`wildcard/duplicate inventory identity ${entry.id}`);
    }
    registered.add(entry.id);
    const site = found.get(entry.id);
    if (!site) { throw new Error(`stale inventory site ${entry.id}`); }
    if (entry.category !== site.category) { throw new Error(`category mismatch ${entry.id}`); }
    if (Object.keys(entry).sort().join(',') !== 'category,evidence,id,review') {
      throw new Error(`unsupported inventory fields ${entry.id}`);
    }
    if (entry.review?.status !== 'pending' || !entry.review.reason?.trim()
        || !Array.isArray(entry.review.authorities) || !entry.review.authorities.length
        || entry.review.authorities.some(authority => typeof authority !== 'string' || !authority.trim())
        || Object.keys(entry.review).sort().join(',') !== 'authorities,reason,status') {
      throw new Error(`missing pending authority hold ${entry.id}`);
    }
    if (entry.evidence?.file !== `src/${site.file}` || entry.evidence.line !== site.line
        || entry.evidence.gate !== INVENTORY_GATE
        || Object.keys(entry.evidence).sort().join(',') !== 'file,gate,line') {
      throw new Error(`missing exact verification pointer ${entry.id}`);
    }
    if (!entry.review.authorities.includes('Backend presentation owner')) {
      throw new Error(`missing presentation ownership hold ${entry.id}`);
    }
    if (site.kind === 'frozen-locale-matrix'
        && (!entry.review.authorities.includes('Human linguistic reviewer')
          || (site.file.startsWith('services/billing/') && !entry.review.authorities.includes('Finance reviewer')))) {
      throw new Error(`missing frozen-copy authority hold ${entry.id}`);
    }
  }
  const missing = sites.filter(site => !registered.has(site.id));
  if (missing.length) { throw new Error(`unclassified source sites: ${missing.map(site => `${site.file}:${site.line} ${site.id}`).join('\n')}`); }
  return {
    inventoryIntegrity: 'accounted-for',
    localizationReadiness: 'incomplete',
    pending: inventory.entries.map(entry => ({ id: entry.id, category: entry.category, ...entry.review })),
    limits: [...DISCOVERY_SCOPE.limits],
  };
}
