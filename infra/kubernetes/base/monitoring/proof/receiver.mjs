import http from 'node:http';

const families = [
  'platform',
  'database',
  'backup',
  'backend',
  'continuity',
  'device',
];
const enabled = new Map(families.map((family) => [family, false]));
let events = [];

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, 'http://receiver');

    if (request.method === 'GET' && url.pathname === '/metrics') {
      const lines = [
        '# HELP vhhealth_c13_synthetic_alert C1.3 disposable routing proof signal.',
        '# TYPE vhhealth_c13_synthetic_alert gauge',
        ...families.map(
          (family) =>
            `vhhealth_c13_synthetic_alert{family="${family}"} ${
              enabled.get(family) ? 1 : 0
            }`,
        ),
        '',
      ];
      return send(response, 200, lines.join('\n'), 'text/plain; version=0.0.4');
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      return send(response, 200, JSON.stringify(events), 'application/json');
    }

    if (request.method === 'POST' && url.pathname === '/reset') {
      events = [];
      for (const family of families) enabled.set(family, false);
      return send(response, 204, '');
    }

    const control = url.pathname.match(/^\/control\/([^/]+)\/(0|1)$/);
    if (request.method === 'POST' && control) {
      if (!enabled.has(control[1])) {
        return send(response, 404, 'unknown family');
      }
      enabled.set(control[1], control[2] === '1');
      return send(response, 204, '');
    }

    const notification = url.pathname.match(/^\/notify\/([^/]+)$/);
    if (request.method === 'POST' && notification) {
      const body = await readBody(request);
      const payload = JSON.parse(body);
      for (const alert of payload.alerts || []) {
        events.push({
          receiver: notification[1],
          status: alert.status,
          alertname: alert.labels?.alertname,
          team: alert.labels?.team,
        });
      }
      return send(response, 200, 'ok');
    }

    return send(response, 404, 'not found');
  })
  .listen(8080, '0.0.0.0', () => {
    console.log('C1.3 synthetic exporter/receiver listening on :8080');
  });

function send(response, statusCode, body, contentType = 'text/plain') {
  response.writeHead(statusCode, { 'content-type': contentType });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
