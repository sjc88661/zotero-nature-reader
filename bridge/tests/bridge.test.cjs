const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').posix;
const Core = require('../addon/content/core.js');
const Store = require('../addon/content/store.js');
const Adapter = require('../addon/content/adapter.js');
const fs = require('node:fs');
const vm = require('node:vm');

const paperA = { libraryID: 1, itemKey: 'ABCDEFGH', title: '一篇论文：Title / test', firstAuthor: '张', authors: ['张三'], year: '2026', journal: 'Journal', doi: '10.1000/example', attachmentKey: 'PDFKEY01' };
const paperB = { ...paperA, itemKey: 'IJKLMNOP', title: '第二篇论文' };
const record = (id, answer = '回答 **Markdown** $x^2$') => ({ id, inputText: '为什么？', outputText: answer, createdAt: 1700000000000 });

function memoryHost() {
  const files = new Map();
  const errors = [];
  let blocked = false;
  const host = {
    statePath: '/local/state.json', join: path.join, settings: () => ({ vaultPath: '/vault', folder: '文献阅读' }), log: error => errors.push(error.message),
    io: {
      exists: async file => file === '/vault/.obsidian' || files.has(file),
      mkdir: async () => {},
      read: async file => { if (!files.has(file)) throw new Error('missing'); return files.get(file); },
      write: async (file, text, options = {}) => {
        if (blocked && file.startsWith('/vault/')) throw new Error('vault unavailable');
        if (options.createOnly && files.has(file)) throw new Error('file exists');
        files.set(file, text);
      },
      findNotes: async (_vault, id) => [...files].filter(([file, text]) => file.startsWith('/vault/') && file.endsWith('.md') && Core.noteIdentity(text) === id).map(([file]) => file.slice('/vault/'.length))
    }
  };
  return { host, files, errors, setBlocked: value => { blocked = value; } };
}

test('一篇文献一篇笔记，重试去重并保留个人整理与自定义 YAML', async () => {
  const { host, files } = memoryHost();
  const store = new Store(host);
  await store.capture(record('one'), paperA);
  const target = await store.open(paperA);
  let text = files.get(target.path).replace('## 个人整理\n\n', '## 个人整理\n\n手写研究想法，不得覆盖。\n\n').replace('tags: [文献阅读]', 'tags: [文献阅读, 我的标签]\ncustom: "保留"');
  files.set(target.path, text);
  await store.capture(record('two'), paperA);
  await store.capture(record('one', '重试后的新回答'), paperB);
  const markdown = files.get(target.path);
  assert.equal([...files.keys()].filter(file => file.endsWith('.md')).length, 1);
  assert.equal((markdown.match(/### 讨论 /g) || []).length, 2);
  assert.match(markdown, /手写研究想法，不得覆盖。/);
  assert.match(markdown, /custom: "保留"/);
  assert.match(markdown, /重试后的新回答/);
  assert.match(markdown, /zotero:\/\/select\/library\/items\/ABCDEFGH/);
  assert.match(markdown, /zotero:\/\/open-pdf\/library\/items\/PDFKEY01/);
  assert.equal(store.state.records['overlay:one'].paperId, Core.paperId(paperA));
});

test('断开笔记库后记录持久化，重启后补同步且不丢失旧记录', async () => {
  const fixture = memoryHost();
  fixture.setBlocked(true);
  const store = new Store(fixture.host);
  await store.capture(record('pending'), paperA);
  const saved = JSON.parse(fixture.files.get('/local/state.json'));
  assert.equal(saved.records['overlay:pending'].answer, record('pending').outputText);
  assert.equal(saved.notes[Core.paperId(paperA)].dirty, true);
  fixture.setBlocked(false);
  const reloaded = new Store(fixture.host);
  await reloaded.retry();
  assert.equal(reloaded.state.notes[Core.paperId(paperA)].dirty, false);
  assert.equal([...fixture.files.keys()].filter(file => file.endsWith('.md')).length, 1);
});

test('笔记移动改名后按文献标识找回；未关联讨论及历史记录导入保持幂等', async () => {
  const { host, files } = memoryHost();
  const store = new Store(host);
  await store.capture(record('history'), null);
  assert.equal((await store.pending()).length, 1);
  const imported = await store.importRecords([record('history')], paperA);
  const oldPath = imported.target.path;
  const moved = '/vault/其他目录/我重命名的笔记.md';
  files.set(moved, files.get(oldPath));
  files.delete(oldPath);
  await store.capture(record('new'), paperA);
  const repeated = await store.importRecords([record('history')], paperB);
  assert.equal(repeated.imported, 0);
  assert.equal([...files.keys()].filter(file => file.endsWith('.md')).length, 1);
  assert.equal((files.get(moved).match(/### 讨论 /g) || []).length, 2);
  assert.equal(store.state.records['overlay:history'].paperId, Core.paperId(paperA));
  assert.equal(store.state.notes[Core.paperId(paperA)].relativePath, '其他目录/我重命名的笔记.md');
});

test('管理区损坏时保留原文件；对话中的标记不会破坏管理区', async () => {
  const { host, files } = memoryHost();
  const store = new Store(host);
  await store.capture(record('markers', '<!-- zob:info:start -->\n正常回答'), paperA);
  const target = await store.open(paperA);
  assert.match(files.get(target.path), /&lt;!-- zob:info:start --&gt;/);
  const damaged = files.get(target.path).replace('<!-- zob:discussions:end -->', '我删除了标记');
  files.set(target.path, damaged);
  await store.capture(record('keep'), paperA);
  assert.equal(files.get(target.path), damaged);
  assert.equal(store.state.notes[Core.paperId(paperA)].dirty, true);
  assert.throws(() => Core.relativeFolder('../其他库'), /相对路径/);
  assert.throws(() => Core.relativeFolder('C:\\temp'), /相对路径/);
});

test('AI 整理稿追加保存，并保留个人内容与原始讨论', async () => {
  const { host, files } = memoryHost();
  const store = new Store(host);
  await store.capture(record('source'), paperA);
  const first = await store.addSummary(paperA, '第一版整理稿');
  files.set(first.path, files.get(first.path).replace('## 个人整理\n\n', '## 个人整理\n\n我的手写批注。\n\n'));
  await store.addSummary(paperA, '第二版整理稿');
  const text = files.get(first.path);
  assert.match(text, /第一版整理稿/);
  assert.match(text, /第二版整理稿/);
  assert.match(text, /我的手写批注。/);
  assert.match(text, /回答 \*\*Markdown\*\* \$x\^2\$/);
  assert.match(Core.summaryChunks(paperA, await store.snapshot(paperA).then(snapshot => snapshot.records))[0], /\[\[#\^zob-/);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fakeView(gate, citedGate = null) {
  const nodes = [];
  const view = {
    conversationHistory: [],
    getTriggerTag: text => text.startsWith('#tag') ? { tag: 'tag' } : null,
    getAllCiteProps: async () => { if (citedGate) await citedGate.promise; return { docs: [], images: [] }; },
    createActiveOutputBox(inputText) {
      const attributes = { inputText, outputText: '' };
      const node = { dataset: {}, isConnected: true, getAttribute: name => attributes[name], setAttribute: (name, value) => { attributes[name] = value; } };
      nodes.push(node); return node;
    },
    async recordConversation(node, output) {
      node.dataset.overlayHistoryId ||= 'capture-' + nodes.indexOf(node);
      node.setAttribute('outputText', output);
      this.conversationHistory.push({ id: node.dataset.overlayHistoryId, inputText: node.getAttribute('inputText'), outputText: output, createdAt: 1700000000000 });
    },
    async ask(text) { await gate.promise; const node = this.createActiveOutputBox(text); await this.recordConversation(node, '完整回答'); return '正常结果'; },
    async execTag(tag) { await this.getAllCiteProps(); await gate.promise; const node = this.createActiveOutputBox('tag prompt', tag); await this.recordConversation(node, '标签回答'); return '正常结果'; },
    async execText(text) { const tag = this.getTriggerTag(text); const { docs } = await this.getAllCiteProps(); return tag ? this.execTag(tag) : this.ask(text, docs); }
  };
  return view;
}

test('发问后切换 PDF，普通问题和异步文献上下文仍归属于原文献', async () => {
  for (const method of ['ask', 'execText']) {
    let current = paperA;
    const gate = deferred();
    const citations = method === 'execText' ? deferred() : null;
    const view = fakeView(gate, citations);
    const captured = [];
    const binding = Adapter.attach(view, { currentPaper: () => current, capture: (row, paper) => captured.push({ row, paper }), log: error => { throw error; } });
    const result = view[method]('question');
    current = paperB;
    citations?.resolve();
    gate.resolve();
    assert.equal(await result, '正常结果');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].paper.itemKey, paperA.itemKey);
    binding.detach();
  }
});

test('标签请求的异步等待和二次调用不改变文献归属，卸载恢复原接口', async () => {
  let current = paperA;
  const gate = deferred();
  const citations = deferred();
  const view = fakeView(gate, citations);
  const originals = { ...view };
  const captured = [];
  const binding = Adapter.attach(view, { currentPaper: () => current, capture: (row, paper) => captured.push({ row, paper }), log: () => {} });
  const result = view.execText('#tag');
  current = paperB;
  citations.resolve(); gate.resolve();
  await result;
  assert.equal(captured[0].paper.itemKey, paperA.itemKey);
  binding.detach();
  assert.equal(view.ask, originals.ask);
  assert.equal(view.recordConversation, originals.recordConversation);
});

test('归档失败不阻断 Awesome GPT 的回答或改变其返回值', async () => {
  const gate = deferred(); gate.resolve();
  const view = fakeView(gate);
  const errors = [];
  Adapter.attach(view, { currentPaper: () => paperA, capture: () => { throw new Error('disk unavailable'); }, log: error => errors.push(error.message) });
  assert.equal(await view.ask('question'), '正常结果');
  assert.deepEqual(errors, ['disk unavailable']);
});

test('按需整理复用模型接口、隔离聊天历史；模型失败时不写入整理稿', async () => {
  const scope = { ZOBCore: Core, Zotero: {}, Services: {}, IOUtils: {}, PathUtils: {}, ZOBStore: Store, ZOBAdapter: Adapter };
  vm.runInNewContext(fs.readFileSync(require.resolve('../addon/content/runtime.js'), 'utf8'), { globalThis: scope });
  const runtime = Object.create(scope.ZOBRuntime.prototype);
  runtime.jobs = new Map();
  runtime.currentPaper = () => paperA;
  runtime.writeStatus = async () => {};
  runtime.launch = () => {};
  const saved = [];
  runtime.store = {
    snapshot: async () => ({ records: [{ id: 'overlay:source', question: '原始问题', answer: '原始回答', createdAt: 1700000000000 }] }),
    addSummary: async (_paper, content) => { saved.push(content); return { relativePath: 'note.md' }; }
  };
  const requests = [];
  const win = { Meet: { OpenAI: { getGPTResponseByOpenAI: async (prompt, options) => { requests.push({ prompt, options }); return '模拟整理稿'; } } } };
  await runtime.summarize(win);
  assert.deepEqual(saved, ['模拟整理稿']);
  assert.equal(requests[0].options.includeHistory, false);
  assert.equal(requests[0].options.requireCompleteResponse, true);
  assert.match(requests[0].prompt, /原始回答/);
  assert.equal(runtime.jobs.size, 0);
  win.Meet.OpenAI.getGPTResponseByOpenAI = async () => { throw new Error('API failed'); };
  await assert.rejects(runtime.summarize(win), /API failed/);
  assert.deepEqual(saved, ['模拟整理稿']);
  assert.equal(runtime.jobs.size, 0);
});
