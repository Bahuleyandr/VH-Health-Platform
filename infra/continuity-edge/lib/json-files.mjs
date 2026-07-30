import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function assertProtectedFile(
  file,
  {
    label = 'protected file',
    privateMode = false,
    ownerUid,
    ownerGid,
  } = {},
) {
  const target = path.resolve(file);
  const details = await lstat(target);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (privateMode && (details.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be group/world accessible`);
  }
  if (
    process.platform !== 'win32' &&
    ((ownerUid !== undefined && details.uid !== ownerUid) ||
      (ownerGid !== undefined && details.gid !== ownerGid))
  ) {
    throw new Error(`${label} must be owned by ${ownerUid}:${ownerGid}`);
  }
  return { details, target };
}

export async function readProtectedJson(file, { label = 'JSON file' } = {}) {
  const { target } = await assertProtectedFile(file, { label });
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return parsed;
}
