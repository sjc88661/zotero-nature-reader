import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadingEngine } from '../backend/engine.mjs';
import { layoutContentHash } from '../backend/layout.mjs';
import { readingFlow } from '../backend/reading-flow.mjs';

test('layout-only cache upgrades preserve reading/chat, invalidate source changes, and require explicit failure retry', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nature-layout-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^nature-layout-test-/);
    await rm(root, { recursive: true, force: true });
  });
  const pdf = path.join(root, 'paper.pdf'); await writeFile(pdf, '%PDF fixture');
  let calls = 0, fail = false;
  const config = { workRoot: path.join(root, 'work'),
    model: { run() { assert.fail('Layout upgrades must not call a model'); } },
    extract() { assert.fail('Layout upgrades must not extract/resegment the source'); },
    enrichLayout: async input => {
      calls++;
      if (fail) throw new Error('fixture failure');
      return { version: 1, mappingVersion: 2, status: 'ready', fingerprint: input.fingerprint, contentHash: input.contentHash,
        revision: input.contentHash, pages: {}, blocks: {}, fonts: [] };
    } };
  let engine = new ReadingEngine(config); await engine.start();
  const request = { paper: { libraryID: 1, itemKey: 'PAPER001', title: 'Fixture' }, attachmentKey: 'PDFFILE1', pdfPath: pdf };
  const opened = await engine.open(request), doc = engine.get(opened.key);
  doc.reading = { status: 'complete', revision: 9, blocks: [{ id: 'S001', page: 1, order: 0, bbox: [1,2,3,4], original: 'Unchanged 𝛼', translation: '保持原译文', status: 'complete' }], guide: { overview: '保留导读' } };
  // Seed the current flow schema to isolate layout migration from flow migration.
  doc.reading.flow = readingFlow(doc.reading.blocks,doc.paper.title,doc.paper.authors,{});
  doc.source = { blocks: structuredClone(doc.reading.blocks) };
  doc.chat = [{ id: 'one', status: 'complete', question: '保留问题', answer: '保留回答' }];
  await engine.save(doc);
  const original = JSON.stringify({ reading: doc.reading, source: doc.source, chat: doc.chat });
  const pending = await engine.open(request);
  assert.equal(pending.layout.status, 'pending');
  assert.equal(pending.busyReading, false);
  await engine.layoutJobs.get(doc.key);
  assert.equal(engine.snapshot(doc.key).layout.status, 'ready');
  assert.ok(engine.snapshot(doc.key).revision > pending.revision);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify({ reading: doc.reading, source: doc.source, chat: doc.chat }), original);
  const saved = JSON.parse(await readFile(path.join(doc.directory, 'document.json'), 'utf8'));
  assert.equal(saved.layout, undefined);
  assert.equal(JSON.stringify({ reading: saved.reading, source: saved.source, chat: saved.chat }), original);
  await engine.close();
  engine = new ReadingEngine(config); await engine.start(); await engine.open(request);
  await engine.layoutJobs.get(doc.key);
  assert.equal(calls, 1, 'restart must use layout sidecar');
  const resumed = engine.get(doc.key);
  resumed.reading.blocks[0].original += '!';
  fail = true;
  await engine.open(request); await engine.layoutJobs.get(doc.key);
  assert.equal(calls, 2);
  assert.equal(engine.snapshot(doc.key).layout.status, 'error');
  assert.equal(engine.snapshot(doc.key).layout.contentHash, layoutContentHash(resumed.reading.blocks));
  await engine.open(request);
  assert.equal(calls, 2, 'a failed layout must not loop on each open');
  await engine.close();
  engine = new ReadingEngine(config); await engine.start(); await engine.open(request); await engine.layoutJobs.get(doc.key);
  assert.equal(calls, 2, 'failure is cached across restarts');
  fail = false;
  assert.equal(engine.retryLayout(doc.key).layout.status, 'pending');
  await engine.layoutJobs.get(doc.key);
  assert.equal(calls, 3);
  assert.equal(engine.snapshot(doc.key).layout.status, 'ready');
  assert.equal(engine.snapshot(doc.key).reading.revision, 9);
  await engine.close();
  engine = new ReadingEngine({ ...config, extract: async () => ({ blocks: [{ id: 'S001', page: 1, order: 0,
    bbox: [1,2,3,4], original: 'Newly extracted source' }] }) });
  await engine.start();
  const fresh = await engine.open({ ...request, paper: { ...request.paper, itemKey: 'PAPER002' } });
  await engine.source(engine.get(fresh.key), new AbortController().signal);
  assert.equal(engine.snapshot(fresh.key).layout.status, 'pending');
  await engine.layoutJobs.get(fresh.key);
  assert.equal(engine.snapshot(fresh.key).layout.status, 'ready');
  assert.equal(calls, 4, 'new extraction schedules layout without starting reading/model jobs');
  assert.equal(engine.snapshot(fresh.key).reading, null);
  await engine.close();
});

test('旧坐标算法缓存自动本地升级，不改动译文或调用模型',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'nature-layout-migration-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
    assert.match(path.basename(root),/^nature-layout-migration-/);
    await rm(root,{recursive:true,force:true});
  });
  const pdf=path.join(root,'paper.pdf');await writeFile(pdf,'%PDF fixture');let calls=0;
  const config={workRoot:path.join(root,'work'),model:{run(){assert.fail('坐标升级不能调用模型');}},
    enrichLayout:async input=>{calls++;return {version:1,mappingVersion:2,status:'ready',fingerprint:input.fingerprint,
      contentHash:input.contentHash,revision:input.contentHash+':mapping-2',pages:{},blocks:{},fonts:[]};}};
  let engine=new ReadingEngine(config);await engine.start();t.after(async()=>engine.close());
  const request={paper:{libraryID:1,itemKey:'PAPER001',title:'Fixture'},attachmentKey:'PDFFILE1',pdfPath:pdf};
  const opened=await engine.open(request),doc=engine.get(opened.key);
  doc.source={blocks:[{id:'S001',page:1,order:0,bbox:[0,0,10,10],original:'file'}]};
  doc.reading={status:'complete',revision:1,blocks:[{...doc.source.blocks[0],translation:'文件',status:'complete'}],guide:{overview:'保留'}};
  doc.reading.flow=readingFlow(doc.reading.blocks,doc.paper.title,doc.paper.authors,{});
  const protectedText=JSON.stringify([doc.source,doc.reading]);await engine.save(doc);
  engine.ensureLayout(doc);await engine.layoutJobs.get(doc.key);assert.equal(calls,1);
  const file=path.join(doc.directory,'layout-v1.json'),legacy=JSON.parse(await readFile(file,'utf8'));
  delete legacy.mappingVersion;await writeFile(file,JSON.stringify(legacy));await engine.close();
  engine=new ReadingEngine(config);await engine.start();await engine.open(request);await engine.layoutJobs.get(doc.key);
  assert.equal(calls,2,'旧版坐标缓存必须自动重建');
  assert.equal(engine.snapshot(doc.key).layout.mappingVersion,2);
  assert.equal(JSON.stringify([engine.get(doc.key).source,engine.get(doc.key).reading]),protectedText);
  assert.equal(engine.retryLayout(doc.key).layout.status,'pending','手动刷新也必须能重建已完成的坐标缓存');
  await engine.layoutJobs.get(doc.key);assert.equal(calls,3);
  assert.equal(JSON.stringify([engine.get(doc.key).source,engine.get(doc.key).reading]),protectedText);
});
