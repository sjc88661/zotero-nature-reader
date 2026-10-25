const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').posix;
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../addon/content/core.js');
const Store = require('../addon/content/store.js');

test('图表阅读提示与图片一起自动归档且保留个人整理',async()=>{
  const f=fixture(),store=new Store(f.host),source=reading();
  const result=await store.archiveReading(paper,source),file='/vault/'+result.relativePath;
  f.files.set(file,f.files.get(file).replace('## 个人整理\n\n','## 个人整理\n\n我的观察。\n\n'));
  source.revision++;source.blocks[2].readingNote={status:'complete',text:'分面与结论的解释 [figure-1 p.2]',mode:'image'};
  await store.archiveReading(paper,source);
  const text=f.files.get(file);assert.ok(text.includes('我的观察。'));assert.ok(text.includes('**图表阅读提示** · 依据原图、图注与正文'));
  assert.ok(text.includes(source.blocks[2].readingNote.text));assert.equal(text.match(/!\[\[/g)?.length,1);
  source.blocks[2].readingNote.mode='invented';assert.throws(()=>Core.normalizeReading(source),/阅读提示格式/);
});

test('metadata migration folds affiliations once, preserves source anchors and personal content', async () => {
  const f=fixture(), store=new Store(f.host);
  const source=reading();
  source.blocks.push({id:'affiliation',page:1,type:'paragraph',order:4,status:'complete',
    original:'1Department of Biology, Ghent University, Belgium. Correspondence: n@example.org.',translation:'1比利时，根特大学，生物学系。通讯作者：n@example.org。'});
  const result=await store.archiveReading(paper,source), file='/vault/'+result.relativePath;
  const note=f.files.get(file).replace('## 个人整理\n\n','## 个人整理\n\n保留我的笔记。\n\n');
  const legacy=note.replace(/^> \[!info\]- 作者、单位与通讯信息\n/m,'').replace(/^> /gm,'');
  f.files.set(file,legacy);
  const state=JSON.parse(f.files.get(f.host.statePath)); delete state.metadataLayoutVersion;
  const preserved=JSON.stringify(state.readings);
  f.files.set(f.host.statePath,JSON.stringify(state));
  const migrated=new Store(f.host); await migrated.ready;
  assert.equal(migrated.state.notes['1:PAPER001'].dirty,true);
  await migrated.save(); await migrated.retry();
  const updated=f.files.get(file),outside=text=>text.replace(/<!-- zob:nature:start -->[\s\S]*?<!-- zob:nature:end -->/,'');
  assert.equal(outside(updated),outside(legacy));
  assert.equal(updated.match(/> \[!info\]- 作者、单位与通讯信息/g)?.length,1);
  assert.ok(updated.indexOf('> [!info]-') < updated.indexOf('The full original paragraph.',updated.indexOf('#### 全文双语对照')));
  assert.ok(updated.includes('> ^'+Core.readingAnchor(source.id,'affiliation')));
  assert.ok(updated.includes('> '+source.blocks.at(-1).translation));
  assert.equal(JSON.stringify(migrated.state.readings),preserved);
  const restarted=new Store(f.host);await restarted.ready;
  assert.equal(restarted.state.notes['1:PAPER001'].dirty,false);
  const writes=f.writes.length;await restarted.retry();assert.equal(f.writes.length,writes);
});

const paper = { libraryID: 1, itemKey: 'PAPER001', attachmentKey: 'PDFFILE1', groupID: 42, title: '完整双语文献', authors: ['张三'], firstAuthor: '张', year: '2026' };
const otherPaper = { ...paper, itemKey: 'PAPER002', title: '另一篇文献' };
const identity = Core.paperId(paper);
const messageId = '5f9636da-d9da-4ea9-b63e-ce9fd7d1d720';
const external = (fields = {}) => ({ source: 'dsh', id: messageId, question: '这篇论文的依据是什么？', answer: '', status: 'pending', createdAt: 1700000000000, updatedAt: 1700000000000, ...fields });
const reading = (fields = {}) => ({
  id: 'PDFFILE1:' + 'a'.repeat(64), attachmentKey: 'PDFFILE1', fingerprint: 'a'.repeat(64), title: '正文 PDF',
  status: 'translating', revision: 1, totalBlocks: 3, doneBlocks: 1, updatedAt: 1700000000000,
  blocks: [
    { id: 'heading-1', page: 1, type: 'heading', order: 0, original: 'Introduction', translation: '引言', status: 'complete' },
    { id: 'paragraph-1', page: 1, type: 'paragraph', order: 1, original: 'The full original paragraph.', translation: '', status: 'pending', bbox: [10, 20, 300, 50] },
    { id: 'figure-1', page: 2, type: 'figure', order: 2, original: 'Figure 1. Original caption.', translation: '', status: 'pending', asset: 'figures/figure-1.png' }
  ],
  guide: { overview: '论文概览', readingOrder: ['heading-1', 'figure-1'], highlights: [{ category: '关键证据', blockId: 'paragraph-1', original: 'The full original paragraph.', translation: '完整的原文段落。', explanation: '需要结合图一理解。' }], glossary: [{ term: 'evidence', translation: '证据', note: '保留原文定位' }] },
  assets: [{ name: 'figures/figure-1.png', sourcePath: '/cache/figure-1.png' }], sourceMapPath: '/cache/source_map.json', notes: ['扫描页须核对'],
  ...fields
});

function fixture() {
  const files = new Map([['/cache/figure-1.png', 'original-image'], ['/cache/source_map.json', '{"page":1}']]);
  const writes = [];
  let blocked = false;
  const host = {
    statePath: '/local/state.json', join: path.join, settings: () => ({ vaultPath: '/vault', folder: '文献阅读' }), log: () => {},
    io: {
      exists: async file => file === '/vault/.obsidian' || files.has(file),
      mkdir: async () => {}, read: async file => { if (!files.has(file)) throw new Error('missing source: ' + file); return files.get(file); },
      write: async (file, text, options = {}) => {
        if (blocked && file.startsWith('/vault/')) throw new Error('vault unavailable');
        if (options.createOnly && files.has(file)) throw new Error('file exists');
        if (file.startsWith('/vault/')) assert.ok(files.has('/local/state.json'), 'local state must be saved before vault writes');
        files.set(file, text); writes.push(file);
      },
      copy: async (source, target) => {
        if (blocked) throw new Error('vault unavailable');
        assert.ok(files.has('/local/state.json'), 'local state must be saved before asset copies');
        if (!files.has(source)) throw new Error('missing source: ' + source);
        files.set(target, files.get(source)); writes.push(target);
      },
      findNotes: async (_vault, id) => [...files].filter(([file, text]) => file.startsWith('/vault/') && file.endsWith('.md') && Core.noteIdentity(text) === id).map(([file]) => file.slice('/vault/'.length))
    }
  };
  return { files, host, writes, block: value => { blocked = value; } };
}

function runtimeFor(store) {
  const scope = { ZOBCore: Core, ZOBStore: Store, Zotero: {}, Services: {}, IOUtils: {}, PathUtils: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../addon/content/runtime.js'), 'utf8'), { globalThis: scope });
  const runtime = Object.create(scope.ZOBRuntime.prototype);
  runtime.store = store;
  runtime.writeStatus = async () => {};
  runtime.log = error => { throw error; };
  return runtime;
}

test('v1 旧笔记只追加一个精读区，个人内容与旧讨论保留；损坏标记时停止覆盖', async () => {
  const f = fixture();
  const legacy = { id: 'overlay:legacy', paperId: identity, question: '原问题', answer: '原回答', createdAt: 11, updatedAt: 12 };
  const summary = { content: '旧 AI 整理稿', createdAt: 13 };
  let old = Core.mergeNote(null, paper, [legacy], [summary]);
  old = old.replace(/\n*## Nature 双语精读[\s\S]*$/, '\n').replace('tags: [文献阅读]', 'tags: [文献阅读]\ncustom: "保留所有字节"')
    .replace('## 个人整理\n\n', '## 个人整理\n\n手写段落和空白  \n\n') + '\n尾部手写内容。\r\n';
  const target = '/vault/旧笔记.md';
  f.files.set(target, old);
  f.files.set('/local/state.json', JSON.stringify({ version: 1, records: { [legacy.id]: legacy }, notes: { [identity]: { paper, relativePath: '旧笔记.md', dirty: false, annotationsSectionAdded: true } }, summaries: { [identity]: [summary] } }));
  const store = new Store(f.host);
  assert.equal((await store.archiveReading(paper, reading())).synced, true);
  let text = f.files.get(target);
  assert.equal(text.slice(0, old.length), old);
  assert.equal((text.match(/<!-- zob:nature:start -->/g) || []).length, 1);
  assert.deepEqual(store.state.records[legacy.id], legacy);
  await store.archiveReading(paper, reading({ revision: 2, updatedAt: 1700000000001 }));
  text = f.files.get(target);
  assert.equal((text.match(/<!-- zob:nature:start -->/g) || []).length, 1);
  const damaged = text.replace('<!-- zob:nature:end -->', '误删结束标记');
  f.files.set(target, damaged);
  const result = await store.archiveReading(paper, reading({ revision: 3, updatedAt: 1700000000002 }));
  assert.equal(result.synced, false);
  assert.match(result.error, /管理区标记/);
  assert.equal(f.files.get(target), damaged);
  assert.equal(store.state.notes[identity].dirty, true);
});

test('公开归档接口先保存空回答提问，再原位更新流式回答；旧快照和切换文献不改变原归属', async () => {
  const f = fixture();
  const store = new Store(f.host);
  const runtime = runtimeFor(store);
  const pending = await runtime.archiveExternal({ paper, record: external() });
  assert.deepEqual(Object.keys(pending).sort(), ['error', 'relativePath', 'synced']);
  assert.equal(pending.synced, true);
  const target = '/vault/' + pending.relativePath;
  assert.match(f.files.get(target), /这篇论文的依据是什么？/);
  assert.match(f.files.get(target), /DeepSeek Harness/);
  assert.match(f.files.get(target), /pending/);
  await runtime.archiveExternal({ paper, record: external({ status: 'streaming', answer: '部分回答', updatedAt: 1700000000001 }) });
  await runtime.archiveExternal({ paper: otherPaper, record: external({ status: 'complete', answer: '完整回答', createdAt: 1700000000100, updatedAt: 1700000000002 }) });
  await runtime.archiveExternal({ paper, record: external({ status: 'streaming', answer: '迟到的旧回答', updatedAt: 1700000000001 }) });
  const stored = store.state.records['dsh:' + messageId];
  assert.equal(stored.paperId, identity);
  assert.equal(stored.createdAt, external().createdAt);
  assert.equal(stored.answer, '完整回答');
  assert.equal(stored.status, 'complete');
  assert.equal((f.files.get(target).match(/### 讨论 /g) || []).length, 1);
  assert.match(f.files.get(target), /完整回答/);
  assert.doesNotMatch(f.files.get(target), /迟到的旧回答/);
  assert.equal([...f.files.keys()].filter(file => file.endsWith('.md')).length, 1);
});

test('精读保存全文双语、导读与来源定位；更新和移动笔记保留资产、旧源文版本且拒绝旧修订', async () => {
  const f = fixture();
  const store = new Store(f.host);
  const initial = await store.archiveReading(paper, reading());
  const original = '/vault/' + initial.relativePath;
  const moved = '/vault/研究/重命名.md';
  f.files.set(moved, f.files.get(original).replace('## 个人整理\n\n', '## 个人整理\n\n移动后手写内容。\n\n'));
  f.files.delete(original);
  const complete = reading({ revision: 2, status: 'complete', doneBlocks: 3, updatedAt: 1700000000002 });
  complete.blocks[1].translation = '完整的原文段落。'; complete.blocks[1].status = 'complete';
  complete.blocks[2].translation = '图一：原始图注。'; complete.blocks[2].status = 'complete';
  f.files.set('/cache/source_map.json', '{"page":1,"complete":true}');
  const result = await store.archiveReading(paper, complete);
  assert.equal(result.relativePath, '研究/重命名.md');
  const text = f.files.get(moved);
  for (const content of ['Introduction', '引言', 'The full original paragraph.', '完整的原文段落。', 'Figure 1. Original caption.', '图一：原始图注。', '论文概览', '关键证据', 'evidence', '证据', '移动后手写内容。', '3/3']) assert.ok(text.includes(content), content);
  assert.match(text, /zotero:\/\/open-pdf\/groups\/42\/items\/PDFFILE1\?page=2/);
  assert.match(text, /\^zob-nature-/);
  const base = '文献阅读/附件/nature/1-PAPER001/PDFFILE1-' + 'a'.repeat(12);
  assert.ok(text.includes('![[' + base + '/assets/figures/figure-1.png]]'));
  assert.equal(f.files.get('/vault/' + base + '/assets/figures/figure-1.png'), 'original-image');
  assert.equal(f.files.get('/vault/' + base + '/source_map.json'), '{"page":1,"complete":true}');
  assert.equal(f.files.get('/cache/figure-1.png'), 'original-image');
  const stale = await store.archiveReading(paper, reading({ revision: 1, updatedAt: 1700000000010 }));
  assert.equal(stale.synced, false);
  assert.match(stale.error, /过期|旧/);
  assert.equal(f.files.get(moved), text);
  const second = reading({ id: 'PDFFILE1:' + 'b'.repeat(64), fingerprint: 'b'.repeat(64), title: '修订后的 PDF', assets: [], sourceMapPath: undefined, blocks: [{ id: 'new-1', page: 1, type: 'paragraph', order: 0, original: 'A revised source.', translation: '修订后的源文。' }], totalBlocks: 1, doneBlocks: 1 });
  await store.archiveReading(paper, second);
  assert.match(f.files.get(moved), /The full original paragraph\./);
  assert.match(f.files.get(moved), /A revised source\./);
  assert.ok(f.files.has('/vault/' + base + '/assets/figures/figure-1.png'));
});

test('精读与 DSH 离线保存后重载补写到同一笔记；快照排队且返回独立副本，非法资产路径不写库', async () => {
  const f = fixture();
  f.block(true);
  const store = new Store(f.host);
  const runtime = runtimeFor(store);
  const queued = await runtime.archiveReading({ paper, reading: reading() });
  assert.equal(queued.synced, false);
  assert.match(queued.error, /vault unavailable/);
  await runtime.archiveExternal({ paper, record: external({ status: 'interrupted', answer: '保留中断回答', error: '连接中断' }) });
  const saved = JSON.parse(f.files.get('/local/state.json'));
  assert.equal(saved.readings[identity][reading().id].revision, 1);
  assert.equal(saved.records['dsh:' + messageId].answer, '保留中断回答');
  f.block(false);
  const reloaded = new Store(f.host);
  const reloadedRuntime = runtimeFor(reloaded);
  const queuedUpdate = reloadedRuntime.archiveReading({ paper, reading: reading({ revision: 2, status: 'error', error: '某段翻译失败', updatedAt: 1700000000002 }) });
  const queuedSnapshot = reloadedRuntime.readingSnapshot(paper, reading().id);
  await queuedUpdate;
  const snapshot = await queuedSnapshot;
  assert.equal(snapshot.revision, 2);
  snapshot.blocks[0].translation = '不能反向修改状态';
  assert.equal((await reloadedRuntime.readingSnapshot(paper, reading().id)).blocks[0].translation, '引言');
  assert.equal(await reloadedRuntime.readingSnapshot(otherPaper, reading().id), null);
  await reloaded.retry();
  const target = '/vault/' + reloaded.state.notes[identity].relativePath;
  assert.equal([...f.files.keys()].filter(file => file.endsWith('.md')).length, 1);
  assert.match(f.files.get(target), /保留中断回答/);
  assert.match(f.files.get(target), /某段翻译失败/);
  assert.equal(reloaded.state.notes[identity].dirty, false);
  const text = f.files.get(target);
  const invalid = await reloaded.archiveReading(paper, reading({ revision: 3, assets: [{ name: '../escape.png', sourcePath: '/cache/figure-1.png' }] }));
  assert.equal(invalid.synced, false);
  assert.equal(f.files.get(target), text);
  assert.equal((await reloaded.readingSnapshot(paper, reading().id)).revision, 2);
  assert.ok(!f.files.has('/vault/escape.png'));
});

test('管理区全局重叠校验在三、四区迁移及五区笔记中保留全部原文件', async () => {
  for (const regionCount of [3, 4, 5]) {
    const f = fixture();
    let original = Core.mergeNote(null, paper, [], []);
    if (regionCount < 5) original = original.replace(/\n*## Nature 双语精读[\s\S]*$/, '\n');
    if (regionCount < 4) original = original.replace(/## Zotero 标注\n\n<!-- zob:annotations:start -->[\s\S]*?<!-- zob:annotations:end -->\n\n/, '');
    original = original.replace('## 个人整理\n\n', '## 个人整理\n\n必须逐字保留的个人研究笔记。\n\n');
    const migrated = Core.mergeNote(original, paper, [], []);
    assert.match(migrated, /必须逐字保留的个人研究笔记。/);
    for (const name of ['info', 'annotations', 'summary', 'discussions', 'nature']) assert.equal(migrated.split(`<!-- zob:${name}:start -->`).length, 2);
    const movedRegion = regionCount === 5 ? 'nature' : 'discussions';
    const begin = `<!-- zob:${movedRegion}:start -->`;
    const damaged = original.replace(begin, '').replace('## 个人整理', begin + '\n\n## 个人整理');
    const target = '/vault/管理区损坏.md';
    f.files.set(target, damaged);
    f.files.set('/local/state.json', JSON.stringify({ version: 1, records: {}, summaries: {}, notes: { [identity]: { paper, relativePath: '管理区损坏.md', dirty: false, annotationsSectionAdded: regionCount >= 4, natureSectionAdded: regionCount === 5 } } }));
    const store = new Store(f.host);
    const result = await store.archiveReading(paper, reading());
    assert.equal(result.synced, false, `${regionCount} managed regions must fail closed`);
    assert.match(result.error, /管理区.*重叠|重叠.*管理区/);
    assert.equal(f.files.get(target), damaged);
    assert.equal(f.writes.filter(file => file.endsWith('.md')).length, 0);
    assert.equal(store.state.notes[identity].dirty, true);
  }
});

test('本地状态保存失败后的重试必须先持久化最新队列，再写入笔记和资产', async () => {
  for (const kind of ['external', 'reading']) {
    const f = fixture();
    f.files.set('/local/state.json', JSON.stringify({ version: 1, records: {}, notes: {}, summaries: {} }));
    let failState = true;
    const vaultActions = [];
    const assertJournal = () => {
      const saved = JSON.parse(f.files.get('/local/state.json'));
      if (kind === 'external') assert.equal(saved.records['dsh:' + messageId]?.question, external().question);
      else assert.equal(saved.readings?.[identity]?.[reading().id]?.revision, 1);
    };
    const write = f.host.io.write;
    f.host.io.write = async (file, text, options) => {
      if (file === '/local/state.json' && failState) throw new Error('local state unavailable');
      if (file.startsWith('/vault/')) { vaultActions.push('write'); assertJournal(); }
      return write(file, text, options);
    };
    const copy = f.host.io.copy;
    f.host.io.copy = async (source, target) => { vaultActions.push('copy'); assertJournal(); return copy(source, target); };
    f.host.io.mkdir = async file => { if (file.startsWith('/vault/')) { vaultActions.push('mkdir'); assertJournal(); } };
    const store = new Store(f.host);
    const result = kind === 'external' ? await store.archiveExternal(paper, external()) : await store.archiveReading(paper, reading());
    assert.equal(result.synced, false);
    assert.match(result.error, /local state unavailable/);
    assert.deepEqual(vaultActions, []);
    await assert.rejects(store.retry(), /local state unavailable/);
    assert.deepEqual(vaultActions, [], 'a failed journal save must prevent every vault mutation');
    failState = false;
    await store.retry();
    assertJournal();
    assert.ok(vaultActions.length > 0);
    assert.equal(store.state.notes[identity].dirty, false);
    const target = '/vault/' + store.state.notes[identity].relativePath;
    assert.ok(f.files.has(target));
    assert.match(f.files.get(target), kind === 'external' ? /这篇论文的依据是什么？/ : /The full original paragraph\./);
  }
});

test('Windows 资产路径大小写别名被拒绝且保留合法名称原始拼写', async () => {
  for (const names of [['figure.png', 'FIGURE.PNG'], ['Figures/figure.png', 'figures/figure.png']]) {
    const f = fixture();
    const raw = reading({
      assets: names.map(name => ({ name, sourcePath: '/cache/figure-1.png' })), totalBlocks: 2, doneBlocks: 0,
      blocks: names.map((asset, index) => ({ id: 'figure-' + index, page: 1, type: 'figure', order: index, original: 'Figure ' + index, translation: '', asset }))
    });
    const store = new Store(f.host);
    const result = await store.archiveReading(paper, raw);
    assert.equal(result.synced, false);
    assert.match(result.error, /资产路径重复/);
    assert.equal(f.writes.filter(file => file.startsWith('/vault/')).length, 0);
    assert.equal(await store.readingSnapshot(paper, raw.id), null);
    raw.assets.pop(); raw.blocks.pop(); raw.totalBlocks = 1;
    assert.equal(Core.normalizeReading(raw).assets[0].name, names[0]);
  }
});

test('精读导读字段先完整验证，拒绝无效嵌套条目并保留已有快照与后续讨论归档', async () => {
  const f = fixture();
  const store = new Store(f.host);
  assert.equal((await store.archiveReading(paper, reading())).synced, true);
  const savedState = f.files.get('/local/state.json');
  const target = '/vault/' + store.state.notes[identity].relativePath;
  const savedNote = f.files.get(target);
  const invalidGuides = [
    { highlights: [null] }, { glossary: [null] }, { overview: {} }, { overview: null },
    { readingOrder: [null] }, { readingOrder: 'heading-1' }, { readingOrder: null },
    { highlights: null }, { highlights: [[]] }, { highlights: [{ category: '证据' }] },
    { highlights: [{ category: 1, blockId: 'heading-1' }] }, { highlights: [{ category: '证据', blockId: 1 }] },
    ...['original', 'translation', 'explanation'].map(field => ({ highlights: [{ category: '证据', blockId: 'heading-1', [field]: null }] })),
    { glossary: null }, { glossary: [[]] }, { glossary: [{ term: 'evidence' }] },
    { glossary: [{ term: 1, translation: '证据' }] }, { glossary: [{ term: 'evidence', translation: 1 }] },
    { glossary: [{ term: 'evidence', translation: '证据', note: {} }] }
  ];
  for (const guide of invalidGuides) {
    const result = await store.archiveReading(paper, reading({ revision: 2, updatedAt: 1700000000002, guide }));
    assert.equal((await store.readingSnapshot(paper, reading().id)).revision, 1);
    assert.equal(result.synced, false);
    assert.match(result.error, /导读/);
    assert.equal(f.files.get('/local/state.json'), savedState);
    assert.equal(f.files.get(target), savedNote);
  }
  assert.equal((await store.archiveExternal(paper, external({ status: 'complete', answer: '无效导读后仍正常归档。' }))).synced, true);
  assert.match(f.files.get(target), /无效导读后仍正常归档。/);
  assert.match(f.files.get(target), /The full original paragraph\./);
  for (const guide of [{ highlights: [null] }, { glossary: [null] }]) {
    const fresh = fixture();
    const newStore = new Store(fresh.host);
    const result = await newStore.archiveReading(paper, reading({ guide }));
    assert.equal(result.synced, false);
    assert.match(result.error, /导读/);
    assert.equal(await newStore.readingSnapshot(paper, reading().id), null);
    assert.equal(Object.keys(newStore.state.notes).length, 0);
    assert.equal(fresh.files.has('/local/state.json'), false);
    assert.equal((await newStore.archiveExternal(paper, external())).synced, true);
  }
});

test('完成态无文字图片块显示原图说明，真正待翻译的文本仍保留提示', () => {
  const visualBlocks = ['figure', 'table', 'equation'].map((type, index) => ({
    id: type + '-image', page: index + 1, type, order: index, original: index === 1 ? ' \n ' : '', translation: '',
    status: index === 2 ? 'pending' : 'complete', asset: type + '.png'
  }));
  const caption = { id: 'caption-complete', page: 1, type: 'caption', order: 3, original: 'Figure 1. The complete caption.', translation: '图一：已完成的图注。', status: 'complete' };
  const complete = reading({
    status: 'complete', totalBlocks: 4, doneBlocks: 4, blocks: [...visualBlocks, caption], guide: null,
    assets: visualBlocks.map(block => ({ name: block.asset, sourcePath: '/cache/' + block.asset })),
    assetPaths: Object.fromEntries(visualBlocks.map(block => [block.asset, '文献阅读/附件/' + block.asset]))
  });
  const render = value => Core.mergeNote(null, paper, [], [], null, true, [value]);
  const note = render(complete);
  assert.doesNotMatch(note, /待翻译/);
  assert.equal((note.match(/原图说明/g) || []).length, 3);
  for (const block of visualBlocks) assert.ok(note.includes('![[文献阅读/附件/' + block.asset + ']]'));
  assert.match(note, /Figure 1\. The complete caption\./);
  assert.match(note, /图一：已完成的图注。/);
  const pending = render({ ...complete, status: 'translating', totalBlocks: 6, blocks: [
    ...complete.blocks,
    { id: 'pending-text', page: 4, type: 'paragraph', order: 4, original: 'This paragraph still needs translation.', translation: '', status: 'pending' },
    { id: 'pending-figure-text', page: 4, type: 'figure', order: 5, original: 'An untranslated figure description.', translation: '', status: 'pending', asset: visualBlocks[0].asset }
  ] });
  assert.equal((pending.match(/（待翻译）/g) || []).length, 2);
  assert.match(pending, /This paragraph still needs translation\./);
  assert.match(pending, /An untranslated figure description\./);
});

test('完整图更新使用新图片，双语图注紧跟图片且分面旧锚点仍保留', async () => {
  const f = fixture(), store = new Store(f.host);
  assert.equal((await store.archiveReading(paper, reading())).synced, true);
  f.files.set('/cache/figure-fixed.png','complete-image-with-labels');
  const fixed = reading({ revision:2, updatedAt:1700000000001, status:'complete',totalBlocks:3,doneBlocks:3,guide:null,
    blocks:[
      {id:'C001',page:2,type:'caption',order:0,original:'Figure 1. Complete caption.',translation:'图 1 完整图注，保持原译文。',status:'complete'},
      {id:'F001',page:2,type:'figure',order:1,original:'',translation:'',status:'complete',asset:'F001-newhash.png',captionIds:['C001']},
      {id:'F002',page:2,type:'figure',order:2,original:'',translation:'',status:'complete',visualParentId:'F001'}
    ], assets:[{name:'F001-newhash.png',sourcePath:'/cache/figure-fixed.png'}] });
  assert.equal((await store.archiveReading(paper,fixed)).synced,true);
  const note=f.files.get('/vault/'+store.state.notes[identity].relativePath);
  const image=note.match(/!\[\[([^\]]+F001-newhash\.png)\]\]/);
  assert.ok(image);assert.equal(f.files.get('/vault/'+image[1]),'complete-image-with-labels');
  assert.ok(note.indexOf(image[0]) < note.indexOf('Figure 1. Complete caption.'));
  assert.equal(note.split('图 1 完整图注，保持原译文。').length-1,1);
  assert.ok(note.includes('^'+Core.readingAnchor(fixed.id,'F002')));
  assert.equal((note.match(/!\[\[/g)||[]).length,1);
  assert.doesNotMatch(note,/待翻译/);
});
