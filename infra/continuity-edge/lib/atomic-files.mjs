import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  'EBADF',
  'EISDIR',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EPERM',
]);

export async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function fsyncTree(root) {
  const entry = await stat(root);
  if (entry.isFile()) {
    const handle = await open(root, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  if (!entry.isDirectory()) throw new Error(`refusing to fsync non-regular path: ${root}`);
  const children = await readdir(root, { withFileTypes: true });
  for (const child of children) {
    if (child.isSymbolicLink()) throw new Error('SYMLINK_ESCAPE');
    const target = path.join(root, child.name);
    if (child.isDirectory()) {
      await fsyncTree(target);
    } else if (child.isFile()) {
      await fsyncTree(target);
    } else {
      throw new Error('ASSET_EXTRA');
    }
  }
  await fsyncDirectory(root);
}

export async function atomicWriteFile(target, bytes, { mode = 0o600 } = {}) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: 'wx', mode });
  const handle = await open(temporary, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await fsyncDirectory(directory);
}
