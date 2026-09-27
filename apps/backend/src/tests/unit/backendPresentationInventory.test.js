import fs from 'node:fs';
import {
  DISCOVERY_SCOPE,
  FIVE_LOCALES,
  INVENTORY_GATE,
  scanBackendPresentations,
  validatePresentationInventory,
} from '../helpers/backendPresentationInventory.js';

const inventory = JSON.parse(fs.readFileSync(new URL('../fixtures/backendPresentationInventory.json', import.meta.url), 'utf8'));
const sample = source => scanBackendPresentations([{ file: 'services/example.js', source }]);
const matrix = (name = 'wording', overrides = {}) => `const ${name} = ${JSON.stringify(
  Object.fromEntries(FIVE_LOCALES.map(locale => [locale, { title: `${locale} title`, body: `${locale} {reference}`, ...overrides[locale] }])),
)};`;

function declaration(sites) {
  return {
    schemaVersion: 1,
    scope: structuredClone(DISCOVERY_SCOPE),
    entries: sites.map(site => ({
      id: site.id,
      category: site.category,
      review: {
        status: 'pending',
        authorities: ['Backend presentation owner', 'Human linguistic reviewer', 'Finance reviewer'],
        reason: 'Synthetic source is accounted for, but no wording or consumer approval has been supplied.',
      },
      evidence: { file: `src/${site.file}`, line: site.line, gate: INVENTORY_GATE },
    })),
  };
}

describe('backend presentation source inventory', () => {
  test('source census has exact two-way held accounting', () => {
    const sites = scanBackendPresentations();
    const result = validatePresentationInventory(sites, inventory);
    expect(result.inventoryIntegrity).toBe('accounted-for');
    expect(result.localizationReadiness).toBe('incomplete');
    expect(result.pending).toHaveLength(sites.length);
    expect(result.pending.length).toBeGreaterThan(4);
    expect(result.limits).toEqual(DISCOVERY_SCOPE.limits);
    expect(new Set(sites.map(site => site.kind))).toEqual(new Set([
      'locale-matrix', 'frozen-locale-matrix', 'scalar-locale-map', 'presentation-object',
      'template-container', 'text-renderer',
      'action-label', 'locale-setting', 'transport', 'sql-notification-write', 'orm-notification-write',
    ]));
  });

  test('known frozen payment copy remains held for finance and linguistic review', () => {
    const entry = inventory.entries.find(item => item.id.startsWith('services/billing/paymentLinkService.js#frozen-locale-matrix:'));
    expect(entry).toBeDefined();
    expect(entry.review.status).toBe('pending');
    expect(entry.review.authorities).toEqual(expect.arrayContaining(['Finance reviewer', 'Human linguistic reviewer']));
    expect(entry.review.reason).toMatch(/frozen/i);
  });

  test('discovers unnamed and quoted locale maps, not just four manually imported exports', () => {
    expect(sample(matrix()).filter(site => site.kind === 'locale-matrix')).toHaveLength(1);
    expect(sample(matrix('fifthContract')).some(site => site.owner.includes('fifthContract'))).toBe(true);
  });

  test('resolves const aliases and Object.freeze without executing modules', () => {
    const source = `throw new Error('must not execute');
      const copy = Object.freeze({title:'frozen', body:'reference {id}'});
      const NEW_PRESENTATIONS = Object.freeze({en:copy,hi:copy,ta:copy,te:copy,ml:copy});`;
    const sites = sample(source);
    expect(sites.filter(site => site.kind === 'frozen-locale-matrix')).toHaveLength(1);
    expect(validatePresentationInventory(sites, declaration(sites)).localizationReadiness).toBe('incomplete');
    expect(() => validatePresentationInventory(sample(source.replace("title:'frozen'", "title:'changed'")), declaration(sites)))
      .toThrow(/stale/);
  });

  test('resolves frozen module string records copied into distinct locale entries without approving wording', () => {
    const source = `throw new Error('must not execute');
      const copy = Object.freeze({title:'Frozen copy', body:'Reference {id}'});
      const NEW_PRESENTATIONS = Object.freeze({
        en:Object.freeze({...copy}),hi:Object.freeze({...copy}),ta:Object.freeze({...copy}),
        te:Object.freeze({...copy}),ml:Object.freeze({...copy})});`;
    const sites = sample(source);
    const matrices = sites.filter(site => site.kind === 'frozen-locale-matrix');
    expect(matrices).toHaveLength(1);
    expect(matrices[0].locales).toEqual([...FIVE_LOCALES].sort());
    expect(matrices[0].fields).toEqual(['body', 'title']);
    const held = declaration(sites);
    expect(validatePresentationInventory(sites, held).localizationReadiness).toBe('incomplete');
    const changed = sample(source.replace('Frozen copy', 'Changed copy'));
    expect(changed.find(site => site.kind === 'frozen-locale-matrix').id).not.toBe(matrices[0].id);
    expect(() => validatePresentationInventory(changed, held)).toThrow(/stale/);
  });

  test('resolves nested frozen string-record copies and preserves genuine prototype-named fields', () => {
    const source = `const title = Object.freeze({title:'Notice'});
      const copy = Object.freeze({...title,body:'Reference {id}',['__proto__']:'Own field'});
      const NEW_PRESENTATIONS = {en:{...copy},hi:{...copy},ta:{...copy},te:{...copy},ml:{...copy}};`;
    const matrices = sample(source).filter(site => site.kind === 'frozen-locale-matrix');
    expect(matrices).toHaveLength(1);
    expect(matrices[0].fields).toEqual(['__proto__', 'body', 'title']);
  });

  test('retains read-only local object aliases and immutable primitive aliases', () => {
    const source = `const title='Notice'; const copy={title,body:'Reference {id}'};
      const alias=copy;
      const NEW_PRESENTATIONS={en:alias,hi:copy,ta:copy,te:copy,ml:alias};`;
    const sites = sample(source);
    expect(sites.filter(site => site.kind === 'frozen-locale-matrix')).toHaveLength(1);
    expect(validatePresentationInventory(sites, declaration(sites)).localizationReadiness).toBe('incomplete');
  });

  test.each([
    `const copy={title:'Notice'}; copy.title='Changed';`,
    `const seed=Object.freeze({title:'Notice'}); const copy={...seed}; copy.title='Changed';`,
    `const copy={title:'Notice'}; const alias=copy; alias.title='Changed';`,
    `const copy={title:'Notice'}; const alias=copy; consume(alias);`,
    `const copy={title:'Notice'}; consume(copy);`,
    `const copy={title:'Notice'}; const holder={copy}; consume(holder);`,
    `const copy={title:'Notice'}; function alter(Object){const discarded=Object.freeze(copy);}
      alter({freeze(value){value.title='Changed'; return value;}});`,
    `const copy={title:'Notice'}; Object.assign(copy,{title:'Changed'});`,
    `const copy={title:'Notice'}; delete copy.title;`,
    `const copy={title:'Notice'}; export {copy};`,
  ])('rejects mutable object aliases with mutation or escape: %s', (declarations) => {
    expect(() => sample(`${declarations}
      const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy};`))
      .toThrow(/mutated or escaped static object alias/);
  });

  test.each([
    `Object.freeze = value => ({title:'Replaced'});`,
    `globalThis.Object.freeze = value => ({title:'Replaced'});`,
    `globalThis['Object']['freeze'] = replacement;`,
    `globalThis.Object = replacement;`,
    `delete Object.freeze;`,
    `Object.assign(Object,{freeze:replacement});`,
    `Object.defineProperty(Object,'freeze',{value:replacement});`,
    `Reflect.set(Object,'freeze',replacement);`,
    `const NativeObject=Object; NativeObject.freeze=replacement;`,
    `const NativeObject=globalThis.Object; NativeObject.freeze=replacement;`,
    `const global=globalThis; global.Object.freeze=replacement;`,
    `const {Object:NativeObject}=globalThis; NativeObject.freeze=replacement;`,
    `const {freeze}=Object;`,
  ])('rejects mutation or escape of global freeze authority: %s', (mutation) => {
    expect(() => sample(`${mutation}
      const copy=Object.freeze({title:'Notice'});
      const NEW_PRESENTATIONS={en:{...copy},hi:{...copy},ta:{...copy},te:{...copy},ml:{...copy}};`))
      .toThrow(/Object(?:\.freeze)? authority/);
  });

  test('unrelated local Object bindings do not alter native module freeze authority', () => {
    const source = `function unrelated(Object) { Object.freeze=replacement; }
      const copy=Object.freeze({title:'Notice'});
      const NEW_PRESENTATIONS={en:{...copy},hi:{...copy},ta:{...copy},te:{...copy},ml:{...copy}};`;
    expect(sample(source).filter(site => site.kind === 'frozen-locale-matrix')).toHaveLength(1);
  });

  test.each([
    ['unfrozen record', `const copy={title:'Notice'};`, /frozen module constant/],
    ['mutated record before freezing', `const value={title:'Notice'}; value.title='Changed'; const copy=Object.freeze(value);`, /frozen module constant/],
    ['mutable binding', `let copy=Object.freeze({title:'Notice'});`, /frozen module constant/],
    ['imported record', `import copy from './would-start-service.js';`, /frozen module constant/],
    ['unknown call result', `const copy=Object.freeze(loadCopy());`, /frozen module constant/],
    ['unresolved alias', `const copy=unknown;`, /frozen module constant/],
    ['unfrozen nested value', `const copy=Object.freeze({title:{text:'Notice'}});`, /fields must be strings/],
    ['accessor', `const copy=Object.freeze({get title(){throw new Error('must not execute');}});`, /accessor/],
    ['prototype setter', `const copy=Object.freeze({__proto__:'not an own field',title:'Notice'});`, /prototype setter/],
    ['dynamic key', `const copy=Object.freeze({[field]:'Notice'});`, /computed key/],
    ['shadowed Object', `const Object={freeze: custom}; const copy=Object.freeze({title:'Notice'});`, /shadowed Object/],
    ['direct write', `const copy=Object.freeze({title:'Notice'}); copy.title='Changed';`, /spread source reference/],
    ['delete', `const copy=Object.freeze({title:'Notice'}); delete copy.title;`, /spread source reference/],
    ['increment', `const copy=Object.freeze({title:'Notice'}); copy.title++;`, /spread source reference/],
    ['assignment helper', `const copy=Object.freeze({title:'Notice'}); Object.assign(copy,{title:'Changed'});`, /spread source reference/],
    ['property definition', `const copy=Object.freeze({title:'Notice'}); Object.defineProperty(copy,'title',{value:'Changed'});`, /spread source reference/],
    ['escaped value', `const copy=Object.freeze({title:'Notice'}); consume(copy);`, /spread source reference/],
    ['escaped alias', `const copy=Object.freeze({title:'Notice'}); const other=copy; other.title='Changed';`, /spread source reference/],
    ['array spread', `const copy=Object.freeze({title:'Notice'}); const other=[...copy];`, /spread source reference/],
    ['call spread', `const copy=Object.freeze({title:'Notice'}); consume(...copy);`, /spread source reference/],
    ['cyclic spreads', `const first=Object.freeze({...copy}); const copy=Object.freeze({...first});`, /cyclic static locale value/],
  ])('rejects unsafe or unsupported copied locale input: %s', (_name, declarations, expected) => {
    expect(() => sample(`${declarations}
      const NEW_PRESENTATIONS={en:{...copy},hi:{...copy},ta:{...copy},te:{...copy},ml:{...copy}};`))
      .toThrow(expected);
  });

  test.each([
    `function render(copy) { const NEW_PRESENTATIONS={en:{...copy},hi:{...copy},ta:{...copy},te:{...copy},ml:{...copy}}; }`,
    `function render() { const copy=Object.freeze({title:'Local'}); const NEW_PRESENTATIONS={en:{...copy},hi:{...copy},ta:{...copy},te:{...copy},ml:{...copy}}; }`,
  ])('rejects shadowed and non-module spread bindings: %s', (body) => {
    expect(() => sample(`const copy=Object.freeze({title:'Module'}); ${body}`)).toThrow(/frozen module constant/);
  });

  test.each([
    'en:{...copy,title:"Override"}',
    'en:{title:"Override",...copy}',
    'en:{...copy,...copy}',
  ])('does not silently accept duplicate spread fields: %s', (entry) => {
    expect(() => sample(`const copy=Object.freeze({title:'Notice'});
      const NEW_PRESENTATIONS={${entry},hi:{...copy},ta:{...copy},te:{...copy},ml:{...copy}};`))
      .toThrow(/duplicate locale\/field/);
  });

  test.each([
    ['missing Malayalam', `const NEW_PRESENTATIONS={en:{title:'a'},hi:{title:'b'},ta:{title:'c'},te:{title:'d'}};`, /missing required locale/],
    ['empty wording', matrix('words', { ml: { body: '  ' } }), /empty\/non-string/],
    ['placeholder mismatch', matrix('words', { ml: { body: 'ml {patient}' } }), /placeholder mismatch/],
    ['duplicate locale', `const words = {en:{title:'a'}, en:{title:'b'},hi:{title:'b'},ta:{title:'b'},te:{title:'b'},ml:{title:'b'}};`, /duplicate locale/],
    ['spread', `const words = {en:{title:'a'},hi:{title:'b'},ta:{title:'b'},te:{title:'b'},ml:{title:'b'}, ...other};`, /unsupported spread/],
    ['dynamic value', `const NEW_PRESENTATIONS = buildPresentations();`, /unsupported static locale expression/],
    ['imported alias', `import copy from './would-start-service.js'; const NEW_PRESENTATIONS = copy;`, /unresolved locale alias/],
    ['cyclic alias', `const first = second; const second = first; const NEW_PRESENTATIONS = first;`, /cyclic static locale value/],
    ['shadowed alias', `const copy={title:'text'}; function f(copy) { const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy}; }`, /unresolved/],
    ['destructured shadow', `const copy={title:'text'}; function f({copy}) { const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy}; }`, /unresolved/],
    ['hoisted var shadow', `const copy={title:'text'}; function f() { if (false) { var copy; } const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy}; }`, /unresolved/],
    ['loop-local alias', `import imported from './external.js'; const copy=imported; for (const copy={title:'ok'}; false;) {} const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy};`, /unresolved/],
    ['shadowed Object', `const Object = {freeze: custom}; const NEW_PRESENTATIONS = Object.freeze({en:'a',hi:'b',ta:'c',te:'d',ml:'e'});`, /shadowed Object/],
    ['named class alias', `const copy={title:'text'}; const C=class copy { m() { const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy}; } };`, /unresolved locale alias/],
    ['named class Object', `const C=class Object { static freeze() { return null; } m() { const NEW_PRESENTATIONS=Object.freeze({en:'a',hi:'b',ta:'c',te:'d',ml:'e'}); } };`, /shadowed Object/],
    ['static-block alias leak', `let copy; class Holder { static { const copy={title:'text'}; } } const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy};`, /unresolved locale alias/],
    ['prototype setter', `const copy={__proto__:'not an own field'}; const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy};`, /prototype setter/],
    ['quoted prototype setter', `const copy={'__proto__':'not an own field'}; const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy};`, /prototype setter/],
  ])('rejects unsupported or malformed locale contract: %s', (_name, source, expected) => {
    expect(() => sample(source)).toThrow(expected);
  });

  test.each([
    'class Holder { static { var copy; } }',
    'const Holder=class copy { method() { return copy; } };',
  ])('class bindings do not escape into sibling locale maps: %s', (declaration) => {
    const sites = sample(`const copy={title:'text'}; ${declaration} const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy};`);
    expect(sites.filter(site => site.kind === 'frozen-locale-matrix')).toHaveLength(1);
  });

  test.each([
    `const copy={['__proto__']:'own field'};`,
    `const __proto__='own field'; const copy={__proto__};`,
  ])('preserves genuine own prototype-named fields: %s', (declaration) => {
    const sites = sample(`${declaration} const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy};`);
    const found = sites.filter(site => site.kind === 'frozen-locale-matrix');
    expect(found).toHaveLength(1);
    expect(found[0].fields).toEqual(['__proto__']);
  });

  test('module parsing rejects dynamic with scopes rather than resolving their aliases', () => {
    expect(() => sample(`const copy={title:'text'}; with (external) { const NEW_PRESENTATIONS={en:copy,hi:copy,ta:copy,te:copy,ml:copy}; }`))
      .toThrow(/parse failure/);
  });

  test('extra-language capability is not confused with an exact-five presentation matrix', () => {
    const sites = sample(`const LANG_DISPLAY={en:'English',hi:'Hindi',ta:'Tamil',te:'Telugu',ml:'Malayalam',kn:'Kannada'};`);
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('scalar-locale-map');
    expect(sites[0].locales).toContain('kn');
    expect(validatePresentationInventory(sites, declaration(sites)).localizationReadiness).toBe('incomplete');
    expect(() => sample(matrix().replace(/};$/, ',kn:{title:"kn",body:"kn {reference}"}};'))).toThrow(/exactly five/);
  });

  test('frozen-copy holds do not depend on field insertion order', () => {
    const sites = scanBackendPresentations([{ file: 'services/billing/example.js', source:
      `const first={title:'Frozen',body:'Copy'}; const reordered={body:'Copy',title:'Frozen'};
       const words={en:first,hi:reordered,ta:first,te:reordered,ml:first};` }]);
    const frozen = sites.find(site => site.kind === 'frozen-locale-matrix');
    expect(frozen).toBeDefined();
    const held = declaration(sites);
    expect(validatePresentationInventory(sites, held).localizationReadiness).toBe('incomplete');
    held.entries.find(entry => entry.id === frozen.id).review.authorities = ['Backend presentation owner', 'Human linguistic reviewer'];
    expect(() => validatePresentationInventory(sites, held)).toThrow(/frozen-copy authority/);
  });

  test('placeholder parity preserves delimiters and positional arguments', () => {
    const withBodies = bodies => `const words=${JSON.stringify(Object.fromEntries(FIVE_LOCALES.map(locale => [locale, {
      title: `${locale} title`, body: bodies[locale] || bodies.en,
    }])))};`;
    const validNamed = withBodies({ en: '{name}: {{reference}}', ml: '{{reference}}: {name}' });
    expect(sample(validNamed).some(site => site.kind === 'locale-matrix')).toBe(true);
    const validNumbered = withBodies({ en: '%1$s %2$d', ml: '%2$d %1$s' });
    expect(sample(validNumbered).some(site => site.kind === 'locale-matrix')).toBe(true);
    const positional = withBodies({ en: '%s %d' });
    expect(sample(positional).some(site => site.kind === 'locale-matrix')).toBe(true);
    expect(() => sample(withBodies({ en: '%s %d', ml: '%d %s' }))).toThrow(/placeholder mismatch/);
    expect(() => sample(withBodies({ en: '{id}', ml: '{{id}}' }))).toThrow(/placeholder mismatch/);
    expect(() => sample(withBodies({ en: '{{id}}', ml: '{{id}' }))).toThrow(/malformed placeholder/);
    expect(() => sample(withBodies({ en: '{id}', ml: '${id}' }))).toThrow(/placeholder mismatch/);
  });

  test('millilitre units and computed dose quantities are not Malayalam maps', () => {
    const sites = sample(`const units={ml:{dim:'volume',factor:1},mg:{dim:'mass',factor:0.001}};
      const dose={ml:round2(amount),source:'weight_based',totalMg};
      outbox.queue({title:'Known notice',body:'Pending review'});`);
    expect(sites.map(site => site.kind)).not.toContain('locale-matrix');
    expect(sites.map(site => site.kind)).toEqual(expect.arrayContaining(['transport', 'presentation-object']));
  });

  test('records runtime-authored templates and locale inputs without inventing translations', () => {
    const sites = sample(`const document={language:'ta',text:reviewedHumanText};
      const rendered={title:approvedTemplate.title,body:render(approvedTemplate.body),locale:approvedTemplate.locale};
      placeVoiceCall({message:rendered.body,language:voiceLanguage});`);
    expect(sites.filter(site => site.kind === 'locale-setting')).toHaveLength(3);
    expect(sites.filter(site => site.kind === 'transport')).toHaveLength(1);
    expect(sites.filter(site => site.kind === 'presentation-object')).toHaveLength(1);
    expect(validatePresentationInventory(sites, declaration(sites)).pending).toHaveLength(sites.length);
  });

  test('a machine action key is accounted for without pretending it is translated text', () => {
    const sites = sample(`const metadata={action_label_key:'notificationActionReview'};`);
    expect(sites[0].category).toBe('client-action-key-pending-consumer-review');
    expect(validatePresentationInventory(sites, declaration(sites)).localizationReadiness).toBe('incomplete');
  });

  test('retains template containers, named renderers and SMS/WhatsApp producers', () => {
    const sites = sample(`const NotificationTemplates={reminder: ({name}) => \`Dear \${name}\`};
      function renderAppointmentSms(input) { return input.message; }
      queuePatientSms(payload); sendWhatsApp(payload); queueAppointmentReminderSms(payload);`);
    expect(sites.filter(site => site.kind === 'template-container')).toHaveLength(1);
    expect(sites.filter(site => site.kind === 'text-renderer')).toHaveLength(1);
    expect(sites.filter(site => site.kind === 'transport')).toHaveLength(3);
    const held = declaration(sites);
    expect(validatePresentationInventory(sites, held).pending).toHaveLength(5);
    expect(() => validatePresentationInventory(sample(`const NotificationTemplates={reminder: ({name}) => \`Changed \${name}\`};`), held))
      .toThrow(/stale/);
  });

  test('discovers named arrow and function-expression renderers alongside declarations', () => {
    const source = `function renderFirstSms(input) { return input.message; }`;
    const held = declaration(sample(source));
    for (const renderer of [
      'const renderAppointmentSms = input => input.message;',
      'const renderAppointmentSms = function(input) { return input.message; };',
      'class Writer { renderAppointmentSms(input) { return input.message; } }',
    ]) {
      const sites = sample(`${source}\n${renderer}`);
      expect(sites.filter(site => site.kind === 'text-renderer')).toHaveLength(2);
      expect(() => validatePresentationInventory(sites, held)).toThrow(/unclassified/);
    }
  });

  test('finds real computed-literal calls and ORM writers but ignores declarations, comments and fake calls in strings', () => {
    const sites = sample(`function sendPushNotification() {}
      // sendPushNotification({title:'fake',body:'fake'});
      const text='outbox.queue({title:"fake",body:"fake"})';
      outbox['queue']({title:'Notice',body:'Text'});
      prisma['notifications']['create']({data:payload});`);
    expect(sites.filter(site => site.kind === 'transport')).toHaveLength(1);
    expect(sites.filter(site => site.kind === 'orm-notification-write')).toHaveLength(1);
    expect(() => sample(`prisma.notifications.surpriseWrite(payload)`)).toThrow(/unclassified/);
  });

  test('uses maintained SQL table recognition and retains separate statements', () => {
    const sites = sample('const sql=`INSERT INTO public."notifications" (title) VALUES ($1); INSERT INTO "notification_outbox" (body) VALUES ($2)`;');
    expect(sites.filter(site => site.kind === 'sql-notification-write')).toHaveLength(2);
    expect(new Set(sites.map(site => site.id)).size).toBe(2);
  });

  test('rejects a new map or a second source producer in a previously accounted file', () => {
    const source = matrix();
    const held = declaration(sample(source));
    expect(() => validatePresentationInventory(sample(`${source}\n${matrix('fifth')}`), held)).toThrow(/unclassified/);
    expect(() => validatePresentationInventory(sample(`${source}\noutbox.queue({title:'new',body:'new'})`), held)).toThrow(/unclassified/);
  });

  test('rejects removed and renamed source sites and accounts for identical repeated producers', () => {
    const source = `const first={title:'Notice',body:'Text'}; outbox.queue(payload); outbox.queue(payload);`;
    const sites = sample(source);
    expect(new Set(sites.map(site => site.id)).size).toBe(sites.length);
    const held = declaration(sites);
    expect(() => validatePresentationInventory(sample(source.replace('first=', 'renamed=')), held)).toThrow(/stale/);
    expect(() => validatePresentationInventory(sample(source.replace(' outbox.queue(payload);', '')), held)).toThrow(/stale/);
  });

  test.each([
    ['delete a hold', held => { held.entries.pop(); }],
    ['wildcard', held => { held.entries[0].id = 'services/*'; }],
    ['file-wide identity', held => { held.entries[0].id = 'services/example.js'; }],
    ['duplicate registration', held => { held.entries.push(held.entries[0]); }],
    ['reclassify as metadata', held => { held.entries[0].category = 'non-presentation-metadata'; }],
    ['approved without authority', held => { held.entries[0].review.status = 'approved'; }],
    ['silently drop owner', held => { held.entries[0].review.authorities = ['Human linguistic reviewer']; }],
    ['empty reason', held => { held.entries[0].review.reason = ''; }],
    ['skip flag', held => { held.entries[0].skip = true; }],
    ['fake evidence', held => { held.entries[0].evidence.file = 'nonexistent.test.js'; }],
    ['weaker discovery scope', held => { held.scope.mechanisms.pop(); }],
  ])('cannot conceal pending work: %s', (_name, mutate) => {
    const sites = sample(matrix());
    const held = declaration(sites);
    mutate(held);
    expect(() => validatePresentationInventory(sites, held)).toThrow();
  });

  test('source identities ignore comments and quote style but exact evidence follows source line moves', () => {
    const first = sample(`const copy={title:'Notice',body:'Text'};`);
    const second = sample(`// unchanged wording\nconst copy = { title: "Notice", body: "Text" };`);
    expect(second[0].id).toBe(first[0].id);
    expect(() => validatePresentationInventory(second, declaration(first))).toThrow(/exact verification/);
  });

  test('fails on empty discovery, duplicate source paths and malformed syntax', () => {
    expect(() => scanBackendPresentations([])).toThrow(/empty/);
    expect(() => sample('const unrelated=1;')).toThrow(/empty/);
    expect(() => sample('const broken = {')).toThrow(/parse failure/);
    expect(() => scanBackendPresentations([
      { file: 'a.js', source: matrix() }, { file: 'a.js', source: matrix('duplicate') },
    ])).toThrow(/duplicate/);
    expect(() => validatePresentationInventory([], declaration([]))).toThrow(/empty/);
  });
});
