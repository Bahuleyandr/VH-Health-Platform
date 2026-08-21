// A minimal RESP2 server used by the Redis-loss drill. It is NOT a Redis
// implementation — it answers just enough (INFO / PING / GET / SET / SCRIPT /
// EVALSHA) for ioredis to reach `ready` and for rate-limit-redis to increment,
// so the drill can kill a LIVE connection mid-flight and observe the client's
// real behaviour. Boot-time refusal needs no server at all.
import net from 'node:net';

const store = new Map();

function bulk(s) {
  if (s === null) return '$-1\r\n';
  return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
}

const INFO = [
  '# Server', 'redis_version:7.4.10', 'redis_mode:standalone',
  '# Clients', 'connected_clients:1',
  '# Replication', 'role:master', 'connected_slaves:1',
  '# Persistence', 'loading:0', 'rdb_bgsave_in_progress:0',
  '# Keyspace', '',
].join('\r\n');

function handle(parts) {
  const cmd = String(parts[0] || '').toLowerCase();
  switch (cmd) {
    case 'info': return bulk(INFO);
    case 'ping': return '+PONG\r\n';
    case 'auth': return '+OK\r\n';
    case 'hello': return '-ERR unknown command HELLO\r\n';
    case 'client': return '+OK\r\n';
    case 'quit': return '+OK\r\n';
    case 'set': {
      store.set(parts[1], parts[2]);
      // honour NX: `SET k v PX n NX` must return nil if the key exists
      const flags = parts.slice(3).map((p) => String(p).toUpperCase());
      if (flags.includes('NX') && store.has(parts[1]) && store.get(parts[1]) !== parts[2]) {
        return '$-1\r\n';
      }
      return '+OK\r\n';
    }
    case 'get': return bulk(store.has(parts[1]) ? store.get(parts[1]) : null);
    case 'del': { const had = store.delete(parts[1]); return `:${had ? 1 : 0}\r\n`; }
    case 'script': return bulk('a'.repeat(40));
    // rate-limit-redis expects [ totalHits, resetTimeMs ]
    case 'evalsha':
    case 'eval': {
      const key = parts.find((p, i) => i > 2 && typeof p === 'string') || 'k';
      const n = (Number(store.get(`__hits__${key}`)) || 0) + 1;
      store.set(`__hits__${key}`, String(n));
      return `*2\r\n:${n}\r\n:60000\r\n`;
    }
    default: return '+OK\r\n';
  }
}

// Minimal inline+array RESP request parser.
function parse(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0x2a) { // not '*' — inline command
      const nl = buf.indexOf('\r\n', i);
      if (nl === -1) break;
      const line = buf.slice(i, nl).toString().trim();
      i = nl + 2;
      if (line) out.push(line.split(/\s+/));
      continue;
    }
    const hdr = buf.indexOf('\r\n', i);
    if (hdr === -1) break;
    const count = Number(buf.slice(i + 1, hdr).toString());
    let j = hdr + 2;
    const parts = [];
    let ok = true;
    for (let k = 0; k < count; k += 1) {
      if (buf[j] !== 0x24) { ok = false; break; }
      const lenEnd = buf.indexOf('\r\n', j);
      if (lenEnd === -1) { ok = false; break; }
      const len = Number(buf.slice(j + 1, lenEnd).toString());
      const start = lenEnd + 2;
      if (buf.length < start + len + 2) { ok = false; break; }
      parts.push(buf.slice(start, start + len).toString());
      j = start + len + 2;
    }
    if (!ok) break;
    out.push(parts);
    i = j;
  }
  return { commands: out, rest: buf.slice(i) };
}

export function startFakeRedis(port = 0) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { commands, rest } = parse(buf);
      buf = rest;
      for (const parts of commands) socket.write(handle(parts));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        // Hard kill: destroy live sockets AND stop listening. This is what a
        // node loss looks like to the client — not a graceful QUIT.
        kill: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
