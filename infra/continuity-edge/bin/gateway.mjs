#!/usr/bin/env node
import { loadActivatedEdgeConfig } from '../lib/config.mjs';
import { loadRuntime } from '../lib/runtime.mjs';
import { startGateway } from '../lib/gateway.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function main(env = process.env) {
  const config = await loadActivatedEdgeConfig(env);
  const runtime = await loadRuntime(config.runtimeRoot);
  const server = await startGateway({ config, runtime });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdout.write(
    `continuity edge gateway listening on ${config.gateway.listenHost}:${config.gateway.listenPort}\n`,
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
