import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export async function acquireDirectoryLock(
  lockPath,
  { timeoutMs = 30_000, retryMs = 100 } = {},
) {
  const target = path.resolve(lockPath);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(target, { mode: 0o700 });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(target, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
        throw new Error(`could not acquire lock ${target}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

export async function withDirectoryLock(lockPath, callback, options) {
  const release = await acquireDirectoryLock(lockPath, options);
  try {
    return await callback();
  } finally {
    await release();
  }
}
