// Live contract assertions: validate real runtime payloads against the spec.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ajvReadySpec } from './openapiToAjv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(resolve(__dirname, '../../docs/openapi.json'), 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(ajvReadySpec(spec), 'openapi.json');

/** Validate an inner `data` payload against a named component schema. */
export function assertData(schemaName, data) {
  const validate = ajv.getSchema(`openapi.json#/components/schemas/${schemaName}`);
  if (!validate) throw new Error(`assertData: schema "${schemaName}" not found in spec`);
  if (!validate(data)) {
    throw new Error(`assertData("${schemaName}") failed:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}

/** Validate a full supertest res.body against the operation's 200 response schema. */
export function assertResponse(method, path, body) {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  const ref = op?.responses?.['200']?.content?.['application/json']?.schema?.$ref;
  if (!ref) throw new Error(`assertResponse: no 200 json schema for ${method} ${path}`);
  const name = ref.replace('#/components/schemas/', '');
  const validate = ajv.getSchema(`openapi.json#/components/schemas/${name}`);
  if (!validate(body)) {
    throw new Error(`assertResponse(${method} ${path} -> ${name}) failed:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}
