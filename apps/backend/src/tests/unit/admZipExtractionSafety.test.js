import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const onnxRequire = createRequire(require.resolve('onnxruntime-node/package.json'));
const AdmZip = onnxRequire('adm-zip');
const payload = Buffer.from('Synthetic archive payload');
const sentinel = 'Synthetic outside file';
const methods = [
  {
    name: 'ONNX single-entry flattened extraction', flattened: true,
    extract: (zip, target) => zip.extractEntryTo('nested/library.bin', target, false, true),
  },
  {
    name: 'single-entry maintained-path extraction', flattened: false,
    extract: (zip, target) => zip.extractEntryTo('nested/library.bin', target, true, true),
  },
  {
    name: 'whole-archive synchronous extraction', flattened: false,
    extract: (zip, target) => zip.extractAllTo(target, true),
  },
  {
    name: 'whole-archive asynchronous extraction', flattened: false,
    extract: (zip, target) => zip.extractAllToAsync(target, true),
  },
];

describe.each([false, true])('ONNX adm-zip extraction containment (directory entries: %s)', (directoryEntries) => {
  let root;
  let target;
  let outside;
  let zip;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-admzip-test-'));
    target = path.join(root, 'target');
    outside = path.join(root, 'outside');
    fs.mkdirSync(target);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'library.bin'), sentinel);
    const archive = new AdmZip();
    if (directoryEntries) archive.addFile('nested/', Buffer.alloc(0));
    archive.addFile('nested/library.bin', payload);
    zip = new AdmZip(archive.toBuffer());
    expect(zip.getEntries()).toHaveLength(directoryEntries ? 2 : 1);
    expect(zip.readFile('nested/library.bin')).toEqual(payload);
  });

  afterEach(() => {
    if (!root) return;
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^vh-admzip-test-/);
    fs.rmSync(root, { recursive: true, force: true });
    expect(fs.existsSync(root)).toBe(false);
  });

  test.each(methods)('$name rejects an existing destination file symlink', async (method) => {
    const destination = method.flattened ? target : path.join(target, 'nested');
    fs.mkdirSync(destination, { recursive: true });
    const link = path.join(destination, 'library.bin');
    const outsideFile = path.join(outside, 'library.bin');
    fs.symlinkSync(outsideFile, link, 'file');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(outsideFile));

    const outcome = await Promise.resolve().then(() => method.extract(zip, target))
      .then(() => ({ rejected: false }), error => ({ rejected: true, message: error.message }));
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe(sentinel);
    expect(outcome).toEqual({ rejected: true, message: expect.any(String) });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test.each(methods.filter(method => !method.flattened))(
    '$name rejects an existing destination directory symlink', async (method) => {
      const link = path.join(target, 'nested');
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(outside));

      const outcome = await Promise.resolve().then(() => method.extract(zip, target))
        .then(() => ({ rejected: false }), error => ({ rejected: true, message: error.message }));
      expect(fs.readFileSync(path.join(outside, 'library.bin'), 'utf8')).toBe(sentinel);
      expect(outcome).toEqual({ rejected: true, message: expect.any(String) });
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    },
  );

  test.each(methods)('$name preserves legitimate file creation and overwrite', async (method) => {
    const file = path.join(target, ...(method.flattened ? [] : ['nested']), 'library.bin');
    await method.extract(zip, target);
    expect(fs.readFileSync(file)).toEqual(payload);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);

    fs.writeFileSync(file, 'Synthetic stale content');
    await method.extract(zip, target);
    expect(fs.readFileSync(file)).toEqual(payload);
    expect(fs.readFileSync(path.join(outside, 'library.bin'), 'utf8')).toBe(sentinel);
  });
});
