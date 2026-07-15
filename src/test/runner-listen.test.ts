/**
 * Regression tests for listenOrReject — the guard that stops a port-collision in
 * createTestContext from silently stranding a test run (2026-07-15 visual-states.test.ts
 * 22h-hang finding). A raw listen(port, cb) with no 'error' handler hangs forever on
 * EADDRINUSE; listenOrReject must fail loud instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { listenOrReject } from './runner.ts';

describe('listenOrReject', () => {
  it('resolves when the port is free (port 0 = OS-assigned)', async () => {
    const server = createServer();
    await listenOrReject(server, 0);
    const addr = server.address();
    assert.ok(typeof addr === 'object' && addr !== null && addr.port > 0, 'should be listening on a real port');
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('REJECTS (does not hang) when the port is already in use', async () => {
    const occupier = createServer();
    await listenOrReject(occupier, 0);
    const port = (occupier.address() as { port: number }).port;

    const collider = createServer();
    await assert.rejects(
      listenOrReject(collider, port, 3000),
      (err: NodeJS.ErrnoException) => err.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err.message)),
      'a colliding bind must reject with EADDRINUSE, not hang',
    );
    collider.close();
    await new Promise<void>((r) => occupier.close(() => r()));
  });

  it('rejects with a timeout error if listen never completes within timeoutMs', async () => {
    // Fake server whose listen neither calls back nor errors — the exact silent-strand
    // shape. listenOrReject must reject via its own timeout instead of hanging.
    const fake = {
      listen: (): void => {},
      once: (): void => {},
      removeListener: (): void => {},
    } as unknown as Server;
    await assert.rejects(listenOrReject(fake, 12345, 50), /did not complete within 50ms/);
  });
});
