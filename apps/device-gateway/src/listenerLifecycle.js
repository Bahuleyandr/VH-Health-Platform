const serverClosePromises = new WeakMap();

export function closeListeningServer(server) {
  if (!server) return Promise.resolve();
  // `listening` flips false when close starts, before the listener has emitted
  // `close`; reuse the first close operation so concurrent callers cannot
  // mistake an in-flight close for an already closed listener.
  const pendingClose = serverClosePromises.get(server);
  if (pendingClose) return pendingClose;
  if (!server.listening) return Promise.resolve();

  const closePromise = new Promise((resolve, reject) => {
    let callbackCompleted = false;
    let closeEmitted = false;
    let settled = false;

    const cleanup = () => server.removeListener('close', onClose);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const finish = () => {
      if (settled || !callbackCompleted || !closeEmitted) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onClose = () => {
      closeEmitted = true;
      finish();
    };

    server.once('close', onClose);
    try {
      server.close((err) => {
        if (err) {
          fail(err);
          return;
        }
        callbackCompleted = true;
        finish();
      });
    } catch (err) {
      fail(err);
    }
  });
  let trackedClose;
  trackedClose = closePromise.then(
    () => {
      if (serverClosePromises.get(server) === trackedClose) {
        serverClosePromises.delete(server);
      }
    },
    (err) => {
      if (serverClosePromises.get(server) === trackedClose) {
        serverClosePromises.delete(server);
      }
      throw err;
    },
  );
  serverClosePromises.set(server, trackedClose);
  return trackedClose;
}

export async function rollbackListeningServers(servers, openSockets) {
  for (const socket of [...openSockets]) socket.destroy();
  const listeningServers = servers.filter(Boolean);
  const closing = listeningServers.map(closeListeningServer);
  for (const server of listeningServers) server.closeAllConnections?.();
  return Promise.allSettled(closing);
}
