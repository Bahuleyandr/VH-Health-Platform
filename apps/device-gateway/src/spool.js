import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class SpoolFullError extends Error {
  constructor(message = 'spool full') {
    super(message);
    this.code = 'SPOOL_FULL';
  }
}

export class NdjsonSpool {
  constructor({ dir, source, maxBytes = 50 * 1024 * 1024 }) {
    this.dir = dir;
    this.source = source;
    this.maxBytes = maxBytes;
    this.file = join(dir, `${source}.ndjson`);
    this.deadFile = join(dir, `${source}.dead.ndjson`);
  }

  async ensure() {
    await mkdir(dirname(this.file), { recursive: true });
  }

  async size() {
    try {
      return (await stat(this.file)).size;
    } catch {
      return 0;
    }
  }

  async append(entry) {
    await this.ensure();
    const row = {
      id: entry.id || randomUUID(),
      queued_at: entry.queued_at || new Date().toISOString(),
      source: this.source,
      ...entry,
    };
    const line = `${JSON.stringify(row)}\n`;
    if ((await this.size()) + Buffer.byteLength(line) > this.maxBytes) {
      throw new SpoolFullError();
    }
    const fh = await open(this.file, 'a');
    try {
      await fh.write(line);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return row;
  }

  async entries() {
    try {
      const raw = await readFile(this.file, 'utf8');
      return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async replace(entries) {
    await this.ensure();
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
    await rename(tmp, this.file);
  }

  async remove(id) {
    const remaining = (await this.entries()).filter((entry) => entry.id !== id);
    await this.replace(remaining);
  }

  async deadLetter(entry, reason) {
    await this.ensure();
    const fh = await open(this.deadFile, 'a');
    try {
      await fh.write(`${JSON.stringify({ ...entry, dead_lettered_at: new Date().toISOString(), reason })}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await this.remove(entry.id);
  }

  async stats() {
    const entries = await this.entries();
    const oldest = entries[0]?.queued_at ? (Date.now() - new Date(entries[0].queued_at).getTime()) / 1000 : 0;
    return { depth: entries.length, oldestAgeSeconds: Math.max(0, oldest) };
  }
}
