import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import worker from '../dist/server/index.js';
import { openLocalDatabase } from './local-db.mjs';

const host = '127.0.0.1';
const port = Number(process.env.HAMSA_PORT ?? 4173);
const data = new URL('../.data/', import.meta.url);
mkdirSync(data, { recursive: true });
const db = openLocalDatabase(fileURLToPath(new URL('hamsa.sqlite', data)));

const server = createServer(async (incoming, outgoing) => {
  try {
    const localPort = server.address().port;
    const authority = incoming.headers.host;
    if (![`${host}:${localPort}`, `localhost:${localPort}`].includes(authority)) {
      outgoing.writeHead(400).end();
      return;
    }

    const method = incoming.method;
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const headers = new Headers(incoming.headers);
    headers.set('CF-Connecting-IP', incoming.socket.remoteAddress ?? host);
    headers.delete('X-Forwarded-For');
    const request = new Request(`http://${authority}${incoming.url}`, {
      method,
      headers,
      ...(hasBody && { body: Readable.toWeb(incoming), duplex: 'half' }),
    });
    const response = await worker.fetch(request, { DB: db });
    for (const [name, value] of response.headers) {
      if (name !== 'set-cookie') outgoing.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('set-cookie', cookies);
    outgoing.writeHead(response.status);
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch (error) {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
});

server.listen(port, host, () => {
  console.log(`همسة  http://${host}:${server.address().port}`);
});
process.on('SIGINT', () => server.close(() => db.close()));
