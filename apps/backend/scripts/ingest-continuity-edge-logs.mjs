import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import prisma from '../src/lib/prisma.js';
import { ingestContinuityEdgeLogBatch } from '../src/services/downtime/continuityEdgeAccessService.js';

export function parseArgs(argv) {
  const options = {};
  const allowed = new Set(['actor', 'batch', 'certificate']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error(`unsupported flag: --${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`duplicate flag: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  for (const name of allowed) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const [batchText, certificatePem] = await Promise.all([
    fs.readFile(path.resolve(options.batch), 'utf8'),
    fs.readFile(path.resolve(options.certificate), 'utf8')
  ]);
  let envelope;
  try {
    envelope = JSON.parse(batchText);
  } catch {
    throw new Error('the recovered batch file is not valid JSON');
  }
  const receipt = await ingestContinuityEdgeLogBatch({
    envelope,
    certificatePem,
    importedBy: options.actor
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error.code || 'CONTINUITY_EDGE_LOG_IMPORT_FAILED'}: ${error.message}\n`
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}
