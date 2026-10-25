import { createHash } from 'node:crypto';
import path from 'node:path';

// All Harness processes sharing this profile must contend for the same socket.
// Binding happens before opening the document store or any persisted sessions.
export function readerServicePort(home) {
  const resolved = path.resolve(home);
  const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return 34000 + createHash('sha256').update(identity).digest().readUInt16BE(0) % 14000;
}

const closeServer = server => new Promise(resolve => {
  server.closeAllConnections?.();
  server.close(resolve);
});

export class LocalServiceHost {
  constructor({ port, createServer, activate, log = () => {}, retryMs = 1800 }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Nature 服务端口无效。');
    Object.assign(this, { port, createServer, activate, log, retryMs });
    this.closed = false; this.current = null; this.opening = null;
  }

  async start() {
    this.timer = setInterval(() => this.ensure().catch(this.log), this.retryMs);
    this.timer.unref?.();
    await this.ensure();
  }

  ensure() {
    if (this.closed || this.current) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = this.open().finally(() => { this.opening = null; });
    return this.opening;
  }

  async open() {
    const server = this.createServer();
    const listening = await new Promise((resolve, reject) => {
      const error = value => { server.off('listening', ready); value.code === 'EADDRINUSE' ? resolve(false) : reject(value); };
      const ready = () => { server.off('error', error); resolve(true); };
      server.once('error', error); server.once('listening', ready);
      server.listen({ port: this.port, host: '127.0.0.1', exclusive: true });
    });
    if (!listening) return;
    if (this.closed) { await closeServer(server); return; }
    try {
      const dispose = await this.activate(server);
      this.current = { server, dispose };
    } catch (error) {
      await closeServer(server);
      throw error;
    }
    if (this.closed) await this.release();
  }

  async release() {
    const owned = this.current;
    if (!owned) return;
    this.current = null;
    // Keep the socket claimed until model handles and document writes drain.
    try { await owned.dispose(); }
    finally { await closeServer(owned.server); }
  }

  async close() {
    this.closed = true; clearInterval(this.timer);
    try { await this.opening; }
    finally { await this.release(); }
  }
}
