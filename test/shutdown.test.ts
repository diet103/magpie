import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { closeGracefully } from '../src/shutdown.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

test('shutdown does not wait on a reply that is still open', async () => {
  // A reply that never finishes, like a chat answer being streamed or a client holding a stream open.
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('working');
  });
  const port = await listen(server);
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise<void>((r) => socket.once('connect', () => r()));
  socket.write('GET / HTTP/1.1\r\nHost: test\r\n\r\n');
  await new Promise<void>((r) => socket.once('data', () => r()));

  const started = Date.now();
  await closeGracefully(server, 200);
  const took = Date.now() - started;
  assert.ok(took >= 150, `gave the reply its grace period first (${took} ms)`);
  assert.ok(took < 2000, `then closed without waiting for it to finish (${took} ms)`);
  assert.equal(server.listening, false);
  socket.destroy();
});

test('shutdown is immediate when nothing is in flight', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  // Leaves an idle keep-alive connection behind, as the proxy in front of the app does.
  await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const started = Date.now();
  await closeGracefully(server, 5000);
  assert.ok(Date.now() - started < 1000, 'did not wait out the grace period');
});
