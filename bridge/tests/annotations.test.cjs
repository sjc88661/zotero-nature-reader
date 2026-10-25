const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;
const Core = require('../addon/content/core.js');
const Store = require('../addon/content/store.js');

const paper = { libraryID: 1, itemKey: 'PAPER001', title: '标注文献', authors: ['张三'], firstAuthor: '张', year: '2026', attachmentKey: 'PDFFILE1', groupID: 42 };
const annotation = (key, fields = {}) => ({ itemID: 10, key, attachmentID: 2, attachmentKey: 'PDFFILE1', attachmentTitle: '正文 PDF', type: 'highlight', text: '第一行\n第二行', comment: '我的批注', pageLabel: 'iii', pageIndex: 4, color: '#ffd400', sortIndex: '00004|001', tags: ['重点'], ...fields });

function fixture() {
  const files = new Map();
  let blocked = false;
  let noteWrites = 0;
  const host = {
    statePath: '/state.json', join: path.join, settings: () => ({ vaultPath: '/vault', folder: '文献阅读' }), log: () => {},
    io: {
      exists: async file => file === '/vault/.obsidian' || files.has(file),
      read: async file => files.get(file), mkdir: async () => {},
      write: async (file, text) => {
        if (blocked && file.startsWith('/vault/')) throw new Error('vault unavailable');
        files.set(file, text);
        if (file.endsWith('.md')) noteWrites++;
      },
      copy: async (source, target) => {
        if (blocked) throw new Error('vault unavailable');
        files.set(target, files.get(source));
      },
      findNotes: async (_vault, identity) => [...files].filter(([file, text]) => file.endsWith('.md') && Core.noteIdentity(text) === identity).map(([file]) => file.slice('/vault/'.length))
    }
  };
  return { host, files, block: value => { blocked = value; }, writes: () => noteWrites };
}

test('旧笔记原位增加标注区，修改/删除不重复、不覆盖个人内容，页码链接使用实际 PDF 页数', async () => {
  const f = fixture();
  const identity = Core.paperId(paper);
  const record = { id: 'overlay:one', paperId: identity, question: '原有问题', answer: '原有回答', createdAt: 1 };
  const summary = { createdAt: 1, content: '原有整理稿' };
  let old = Core.mergeNote(null, paper, [record], [summary]);
  old = old.replace(/## Zotero 标注\n\n<!-- zob:annotations:start -->[\s\S]*?<!-- zob:annotations:end -->\n\n/, '')
    .replace('## 个人整理\n\n', '## 个人整理\n\n手写研究想法\n\n').replace('tags: [文献阅读]', 'tags: [文献阅读]\ncustom: "保留"');
  const target = '/vault/已经改名.md';
  f.files.set(target, old);
  f.files.set('/state.json', JSON.stringify({ version: 1, records: { [record.id]: record }, summaries: { [identity]: [summary] }, notes: { [identity]: { paper, relativePath: '已经改名.md', dirty: false } } }));
  const store = new Store(f.host);
  const a = annotation('ANNOT001');
  await store.setAnnotations(paper, [a]);
  let text = f.files.get(target);
  assert.equal(text.slice(0, old.length), old);
  assert.match(text, /第 iii 页/);
  assert.match(text, /open-pdf\/groups\/42\/items\/PDFFILE1\?page=5&annotation=ANNOT001/);
  assert.match(text, /> 第一行\n> 第二行/);
  const writes = f.writes();
  await store.setAnnotations(paper, [a]);
  assert.equal(f.writes(), writes);
  await store.setAnnotations(paper, [{ ...a, comment: '已修改 <!-- zob:annotations:end -->' }, annotation('ANNOT002', { attachmentKey: 'PDFFILE2', type: 'underline' })]);
  text = f.files.get(target);
  assert.equal((text.match(/\^zob-annotation-/g) || []).length, 2);
  assert.match(text, /已修改 &lt;!-- zob:annotations:end --&gt;/);
  await store.setAnnotations(paper, []);
  text = f.files.get(target);
  assert.doesNotMatch(text, /ANNOT001|ANNOT002/);
  for (const preserved of ['手写研究想法', '原有回答', '原有整理稿', 'custom: "保留"']) assert.ok(text.includes(preserved));
  const damaged = text.replace('<!-- zob:annotations:end -->', '误删标记');
  f.files.set(target, damaged);
  await store.setAnnotations(paper, [a]);
  assert.equal(f.files.get(target), damaged);
  assert.equal(store.state.notes[identity].dirty, true);
});

test('标注离线排队重启补写，图片复制到库内并保留笔记移动后的引用', async () => {
  const f = fixture();
  f.files.set('/cache/ANNOT003.png', 'png-data');
  const rows = [annotation('ANNOT003', { type: 'image', text: '', imageSource: '/cache/ANNOT003.png' })];
  f.block(true);
  const store = new Store(f.host);
  await store.setAnnotations(paper, rows);
  assert.equal(JSON.parse(f.files.get('/state.json')).annotations[Core.paperId(paper)].length, 1);
  f.block(false);
  const reloaded = new Store(f.host);
  await reloaded.retry();
  const original = '/vault/' + reloaded.state.notes[Core.paperId(paper)].relativePath;
  const moved = '/vault/移动后.md';
  f.files.set(moved, f.files.get(original));
  f.files.delete(original);
  await reloaded.setAnnotations(paper, [{ ...rows[0], comment: '移动后更新' }]);
  assert.match(f.files.get(moved), /!\[\[文献阅读\/附件\/1-ANNOT003.png\]\]/);
  assert.equal(f.files.get('/vault/文献阅读/附件/1-ANNOT003.png'), 'png-data');
  await reloaded.setAnnotations(paper, []);
  assert.doesNotMatch(f.files.get(moved), /!\[\[/);
  assert.ok(f.files.has('/vault/文献阅读/附件/1-ANNOT003.png'));
});

test('通知同步只补已有笔记；新标注自动归档，删除后清除；退出注销监听', async () => {
  const f = fixture();
  const store = new Store(f.host);
  await store.open(paper);
  const items = new Map();
  const regular = (id, key, attachmentIDs) => ({ id, libraryID: 1, key, isRegularItem: () => true, isAnnotation: () => false, isPDFAttachment: () => false, getAttachments: () => attachmentIDs });
  const parent = regular(1, paper.itemKey, [2]);
  const unrelated = regular(3, 'PAPER002', [4]);
  const attachment = (id, parentID, key) => ({ id, parentID, key, libraryID: 1, isAnnotation: () => false, isPDFAttachment: () => true, getField: () => 'PDF', getAnnotations: () => [...items.values()].filter(item => item.isAnnotation() && item.parentID === id && !item.deleted).map(item => item.id) });
  const a = { id: 10, libraryID: 1, key: 'ANNOT001', parentID: 2, isAnnotation: () => true };
  for (const item of [parent, unrelated, attachment(2, 1, 'PDFFILE1'), attachment(4, 3, 'PDFFILE2'), a]) items.set(item.id, item);
  let observer;
  let unregister;
  const Zotero = {
    Items: {
      exists: id => items.has(id),
      getAsync: async ids => Array.isArray(ids) ? ids.map(id => items.get(id)).filter(Boolean) : items.get(ids),
      getByLibraryAndKeyAsync: async (lib, key) => [...items.values()].find(item => item.libraryID === lib && item.key === key),
      loadDataTypes: async () => {}
    },
    Notifier: { registerObserver: value => { observer = value; return 'observer'; }, unregisterObserver: key => { unregister = key; } },
    Annotations: { toJSONSync: item => ({ type: 'highlight', text: '真实接口格式', comment: item.comment || '', pageLabel: '2', position: { pageIndex: 1 }, sortIndex: '00001', tags: [{ name: '重要' }], dateModified: '2026-10-24T00:00:00Z' }) }
  };
  const scope = { Zotero, ZOBCore: Core };
  vm.runInNewContext(fs.readFileSync(require.resolve('../addon/content/annotations.js'), 'utf8'), { globalThis: scope });
  const runtime = {
    store, io: f.host.io, log: error => { throw error; }, writeStatus: async () => {},
    timerWindow: { setTimeout: () => 1, clearTimeout: () => {} },
    paperFromItem: (item, file) => ({ ...paper, itemKey: item.key, attachmentKey: file?.key || paper.attachmentKey })
  };
  const sync = new scope.ZOBAnnotationSync(runtime);
  sync.start();
  assert.equal(sync.pending.size, 1);
  assert.equal(typeof observer.notify, 'function');
  await sync.flush();
  assert.equal(store.state.annotations[Core.paperId(paper)].length, 1);
  await sync.changed('modify', 'item', [3], {});
  assert.equal(sync.pending.size, 0);
  const newAnnotation = { ...a, id: 11, key: 'ANNOT002', parentID: 4 };
  items.set(11, newAnnotation);
  await sync.changed('add', 'item', [11], {});
  await sync.flush();
  assert.equal(store.state.annotations['1:PAPER002'].length, 1);
  a.comment = '更改后的评论';
  await sync.changed('modify', 'item', [10], {});
  await sync.flush();
  assert.equal(store.state.annotations[Core.paperId(paper)][0].comment, a.comment);
  items.delete(10);
  await sync.changed('delete', 'item', [10], { 10: { libraryID: 1, key: 'ANNOT001' } });
  await sync.flush();
  assert.equal(store.state.annotations[Core.paperId(paper)].length, 0);
  assert.equal(Object.keys(store.state.notes).length, 2);
  await sync.stop();
  assert.equal(unregister, 'observer');
});
