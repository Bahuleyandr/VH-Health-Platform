import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = fileURLToPath(new URL('../src/', import.meta.url));
function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'tests') return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}
function walk(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, callback));
    else if (value?.type) walk(value, callback);
  }
}

export function inspectSignerSource(source, path) {
  const result = [];
  const aliases = new Map();
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration' && node.source.value.endsWith('/documentIntegrityService.js')) {
      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ImportSpecifier') throw new Error(`Unsupported signer import in ${path}`);
        aliases.set(specifier.local.name, specifier.imported.name);
      }
    }
  }
  walk(ast, (node) => {
    if (node.type === 'ImportExpression' && source.slice(node.start, node.end).includes('documentIntegrityService')) {
      throw new Error(`Unsupported dynamic signer import in ${path}`);
    }
    if (node.type === 'ExportNamedDeclaration' && node.source?.value.includes('documentIntegrityService')) {
      throw new Error(`Unsupported signer re-export in ${path}`);
    }
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    const name = aliases.get(callee.name) || callee.name;
    if (!['signDocument', 'signDocumentTx'].includes(name)) return;
    const input = node.arguments[0];
    if (input?.type !== 'ObjectExpression' || input.properties.some((property) => property.type !== 'Property' || property.computed)) {
      throw new Error(`Unsupported signer input in ${path}`);
    }
    const property = input.properties.find((item) => item.key.name === 'documentType');
    const documentType = property?.value.type === 'Literal' ? property.value.value : '<dynamic>';
    result.push({ path, function: name, documentType });
  });
  return result;
}

export function callerCensus() {
  return sources(root).flatMap((path) => inspectSignerSource(readFileSync(path, 'utf8'), relative(root, path).replaceAll('\\', '/')))
    .sort((a, b) => a.path.localeCompare(b.path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const calls = callerCensus();
  process.stdout.write(`${JSON.stringify({ schema: 'cath-pr1-signer-census/v1', count: calls.length, calls }, null, 2)}\n`);
}
