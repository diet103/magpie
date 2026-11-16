// Stopping the HTTP server without making a deploy wait on one open connection.
import type { Server } from 'node:http';
import type { Http2SecureServer, Http2Server } from 'node:http2';

type AnyServer = Server | Http2Server | Http2SecureServer;

/**
 * Stops accepting connections, closes idle ones at once and, after graceMs, the ones still in use (a chat reply
 * being streamed, a client holding a stream open). Resolves when the server has closed.
 */
export function closeGracefully(server: AnyServer, graceMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      if ('closeAllConnections' in server) server.closeAllConnections();
    }, graceMs);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    if ('closeIdleConnections' in server) server.closeIdleConnections();
  });
}
