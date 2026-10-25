import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const build = new URL(import.meta.url).searchParams.get('build') || String(Date.now());
const [{ ReadingEngine, VERSION, PROTOCOL_VERSION, makeExtractor }, { HarnessModel, loadNatureSkills }, { makeLayoutExtractor }, { makeOrderRepair }, { LocalServiceHost, readerServicePort }] = await Promise.all([
  import(new URL(`./engine.mjs?build=${build}`, import.meta.url).href),
  import(new URL(`./harness.mjs?build=${build}`, import.meta.url).href),
  import(new URL(`./layout.mjs?build=${build}`, import.meta.url).href),
  import(new URL(`./reading-order.mjs?build=${build}`, import.meta.url).href),
  import(new URL(`./service-host.mjs?build=${build}`, import.meta.url).href)
]);

export const name = '@dsh-external/zotero-nature-reader';
export const inject = ['agents', 'agentDefaultModel', 'agentPresets', 'sessions', 'sessionPersistence', 'llm', 'attachments'];
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const send = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(text);
};

async function bodyOf(request) {
  let size = 0, chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('请求过大。'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function apply(ctx, config = {}) {
  const home = config.dshHome || process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const host = new LocalServiceHost({
    port: config.servicePort ?? readerServicePort(home),
    createServer: () => http.createServer((_request, response) => send(response, 503, { error: 'Nature 服务正在准备，请稍后重试。' })),
    activate: server => activateReader(ctx, config, home, server),
    log: error => ctx.logger?.warn?.(`[Zotero Nature] ${String(error?.message || error)}`)
  });
  ctx.effect(() => () => host.close(), 'zotero-nature: exclusive reader service');
  await host.start();
}

async function activateReader(ctx, config, home, server) {
  const connectionFile = path.join(home, 'zotero-nature', 'connection.json');
  const skillRoot = config.skillRoot || path.join(homedir(), '.codex', 'skills');
  const nature = await loadNatureSkills(skillRoot);
  const token = randomBytes(32).toString('hex');
  let engine, ready = false;
  const log = error => ctx.logger?.warn?.(`[Zotero Nature] ${String(error?.message || error)}`);
  const dispose = async () => {
    ready = false;
    try { await engine?.close(); }
    finally {
      try {
        const current = JSON.parse(await readFile(connectionFile, 'utf8'));
        if (current.token === token) await unlink(connectionFile);
      } catch (error) { if (error.code !== 'ENOENT') log(error); }
    }
  };
  try {
  const model = new HarnessModel({ ctx, nature, preset: config.agentPreset || 'standard', checkpoint: doc => engine.save(doc) });
  const python = config.python || path.join(project, '.venv', 'Scripts', 'python.exe');
  engine = new ReadingEngine({ workRoot: config.workRoot || path.join(project, 'work'), model,
    extract: makeExtractor(python, path.join(project, 'backend', 'extract.py')),
    reorder: makeOrderRepair(python, path.join(project, 'backend', 'reading_order.py')),
    enrichLayout: makeLayoutExtractor(python, path.join(project, 'backend', 'layout.py')), log });
  await engine.start();
  for (const doc of engine.documents.values()) if (doc.sessions.reading && !doc.guideDraft && doc.reading?.status === 'error' && !doc.reading.guide && doc.reading.doneBlocks === doc.reading.totalBlocks) {
    let handle;
    try {
      handle = await ctx.sessionPersistence.open(doc.sessions.reading, 'read');
      const result = await handle.read();
      const event = [...result.events].reverse().find(item => item.type === 'assistant/message');
      const reply = (event?.data.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
      if (reply !== doc.rejectedGuideDraft && /"overview"\s*:/.test(reply) && /"highlights"\s*:/.test(reply)) { doc.guideDraft = reply; await engine.save(doc); }
    } catch (error) { log(error); }
    finally { await handle?.close(); }
  }
  server.removeAllListeners('request');
  server.on('request', async (request, response) => {
    try {
      if (!ready) return send(response, 503, { error: 'Nature 服务正在准备或关闭，请稍后重试。' });
      const host = request.headers.host || '';
      if (!/^127\.0\.0\.1:\d+$/.test(host) || (request.headers.origin && !/^chrome:\/\//.test(request.headers.origin))) return send(response, 403, { error: '仅接受本机 Zotero 请求。' });
      const given = Buffer.from(String(request.headers.authorization || ''));
      const expected = Buffer.from('Bearer ' + token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(response, 401, { error: '连接凭据已更新，请重新连接 Harness。' });
      const url = new URL(request.url, 'http://' + host);
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true, version: VERSION, protocolVersion: PROTOCOL_VERSION, natureSkills: nature.skills.map(skill => skill.name) });
      if (request.method === 'POST' && url.pathname === '/paper/open') return send(response, 200, await engine.open(await bodyOf(request)));
      const match = url.pathname.match(/^\/paper\/([A-Za-z0-9-]+)(?:\/(generate|chat|cancel|layout))?$/);
      if (match) {
        const [, key, action] = match;
        if (request.method === 'GET' && !action) {
          const doc = engine.get(key);
          if (String(doc.revision) === url.searchParams.get('revision')) return send(response, 200, { unchanged: true, revision: doc.revision });
          return send(response, 200, engine.snapshot(key));
        }
        if (request.method === 'POST') {
          const body = await bodyOf(request);
          if (action === 'generate') return send(response, 202, engine.startReading(key));
          if (action === 'layout') return send(response, 202, engine.retryLayout(key));
          if (action === 'chat') return send(response, 202, await engine.ask(key, body));
          if (action === 'cancel' && ['reading', 'chat'].includes(body.kind)) return send(response, 200, engine.cancel(key, body.kind));
        }
      }
      send(response, 404, { error: '接口不存在。' });
    } catch (error) { send(response, error.statusCode || 400, { error: String(error.message || error) }); }
  });
  await mkdir(path.dirname(connectionFile), { recursive: true });
  await writeFile(connectionFile + '.tmp', JSON.stringify({ protocolVersion: PROTOCOL_VERSION, version: VERSION, pid: process.pid,
    url: `http://127.0.0.1:${server.address().port}`, token, startedAt: Date.now(), project, build }, null, 2), { mode: 0o600 });
  await rename(connectionFile + '.tmp', connectionFile);
  ready = true;
  return dispose;
  } catch (error) { await dispose(); throw error; }
}
