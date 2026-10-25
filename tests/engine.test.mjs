import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadingEngine, parseJSON } from '../backend/engine.mjs';

const paper = { libraryID: 1, itemKey: 'PAPER001', title: '阅读测试', attachmentKey: 'PDFFILE1' };
test('指南解析仅修复提前闭合的外层对象，保持文字与嵌套结构',()=>{
  const raw = '{"overview":"保留 {数据} 与 \\"原文\\""},\n"readingOrder":["先读摘要"],"highlights":[],"glossary":[]}';
  assert.deepEqual(parseJSON(raw),{overview:'保留 {数据} 与 "原文"',readingOrder:['先读摘要'],highlights:[],glossary:[]});
  assert.throws(()=>parseJSON('{"overview":"未完成"},"readingOrder":[ broken }'));
});
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'zotero-nature-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.match(path.basename(resolved), /^zotero-nature-test-/);
    await rm(resolved, { recursive: true, force: true });
  });
  const pdf = path.join(root, 'paper.pdf'); await writeFile(pdf, '%PDF-1.7\nfixture');
  const blocks = [
    { id: 'S001', page: 1, type: 'paragraph', order: 1, original: 'Alpha '.repeat(700), translation: '', bbox: [1,2,3,4] },
    { id: 'S002', page: 2, type: 'paragraph', order: 2, original: 'Beta '.repeat(900), translation: '', bbox: [1,2,3,4] },
    { id: 'F001', page: 2, type: 'figure', order: 3, original: '', translation: '', asset: 'F001.png' }
  ];
  const extract = async (_pdf, dir) => { await mkdir(path.join(dir,'assets'), {recursive:true}); const image=path.join(dir,'assets','F001.png'); await writeFile(image,'png'); return {blocks,assets:[{name:'F001.png',sourcePath:image}],notes:[],...options.source}; };
  const model = options.model || { run: async ({prompt}) => {
    if (prompt.startsWith('为这张图表')) return '图表阅读提示 [F001 p.2]，以图注为依据。';
    if (prompt.includes('生成中文精读指南')) return JSON.stringify({overview:'指南',readingOrder:['先读问题'],highlights:[{category:'研究目标',blockId:'S001',original:'Alpha',translation:'阿尔法',explanation:'原文依据'}],glossary:[]});
    const input=JSON.parse(prompt.slice(prompt.indexOf('\n\n[')+2));
    return JSON.stringify({blocks:input.map(block=>({id:block.id,translation:'译文 '+block.id}))});
  } };
  const config = { workRoot:path.join(root,'work'),model,extract };
  const engine=new ReadingEngine(config); await engine.start();
  const opened=await engine.open({paper,pdfPath:pdf,attachmentKey:paper.attachmentKey});
  return {engine,opened,config,root,pdf,blocks};
}

test('图表补全和提问携带图片，保存阅读提示及重试选图，不重翻已有内容',async t=>{
  const f=await fixture(t);f.engine.startReading(f.opened.key);await f.engine.jobs.get(f.opened.key+':reading').promise;
  const doc=f.engine.get(f.opened.key),before=JSON.stringify({texts:doc.reading.blocks.map(b=>[b.id,b.original,b.translation]),guide:doc.reading.guide});
  const figure=doc.reading.blocks.find(b=>b.id==='F001');delete figure.readingNote;
  let calls=0,fail=false;
  f.engine.model={async run({prompt,images,onInputMode,onText}){
    calls++;assert.equal(images.length,1);assert.equal(images[0].sourcePath,doc.reading.assets[0].sourcePath);
    assert.ok(!prompt.includes('逐项保留 id'));
    if(fail){fail=false;throw new Error('temporary image failure');}
    onInputMode?.('image');onText?.('分面说明');return '解读图像 [F001 p.2]，注意证据边界。';
  }};
  f.engine.startReading(doc.key);await f.engine.jobs.get(doc.key+':reading').promise;
  assert.equal(figure.readingNote.mode,'image');assert.equal(calls,1);
  f.engine.startReading(doc.key);assert.equal(f.engine.jobs.has(doc.key+':reading'),false);
  fail=true;
  await f.engine.ask(doc.key,{id:'figure-question',question:'怎么看这张图',selection:{kind:'figure',blockId:'F001',figureNote:true}});
  await f.engine.jobs.get(doc.key+':chat').promise;
  assert.equal(doc.chat[0].status,'error');
  await f.engine.ask(doc.key,{id:'figure-question',question:doc.chat[0].question,retry:true});
  await f.engine.jobs.get(doc.key+':chat').promise;
  assert.equal(doc.chat.length,1);assert.equal(doc.chat[0].status,'complete');assert.equal(doc.chat[0].imageMode,'image');
  assert.equal(figure.readingNote.recordId,'figure-question');
  assert.equal(JSON.stringify({texts:doc.reading.blocks.map(b=>[b.id,b.original,b.translation]),guide:doc.reading.guide}),before);
  const saved=JSON.parse(await readFile(path.join(doc.directory,'document.json'),'utf8'));
  assert.equal(saved.reading.blocks.find(b=>b.id==='F001').readingNote.text,figure.readingNote.text);
  await f.engine.close();
});

test('全文分段保存与来源映射，缓存重复打开且不同文献隔离', async t => {
  const f=await fixture(t); const {engine,opened}=f;
  engine.startReading(opened.key); await engine.jobs.get(opened.key+':reading').promise;
  const snapshot=engine.snapshot(opened.key);
  assert.equal(snapshot.reading.status,'complete'); assert.equal(snapshot.reading.doneBlocks,3);
  assert.equal(snapshot.reading.blocks[0].original,f.blocks[0].original);
  assert.equal(snapshot.reading.blocks[1].translation,'译文 S002'); assert.equal(snapshot.reading.guide.highlights.length,1);
  assert.equal(snapshot.busyReading,false);
  const map=JSON.parse(await readFile(snapshot.reading.sourceMapPath,'utf8')); assert.equal(map.blocks.length,3); assert.equal(map.status,'complete');
  const reopened=await engine.open({paper,pdfPath:f.pdf,attachmentKey:paper.attachmentKey}); assert.equal(reopened.key,opened.key);
  const other=await engine.open({paper:{...paper,itemKey:'PAPER002'},pdfPath:f.pdf,attachmentKey:paper.attachmentKey}); assert.notEqual(other.key,opened.key); assert.equal(other.reading,null);
  await engine.close();
});

test('中途失败后重启只续翻未完成段落，不重写已完成译文', async t => {
  let calls=0;
  const f=await fixture(t,{model:{run:async({prompt})=>{calls++;if(calls===2)throw new Error('network lost');return JSON.stringify({blocks:[{id:'S001',translation:'已完成的第一段'}]});}}});
  f.engine.startReading(f.opened.key); await f.engine.jobs.get(f.opened.key+':reading').promise;
  assert.equal(f.engine.snapshot(f.opened.key).reading.status,'error');
  assert.equal(f.engine.snapshot(f.opened.key).reading.blocks[0].translation,'已完成的第一段');
  await f.engine.close();
  const prompts=[]; const restarted=new ReadingEngine({...f.config,model:{run:async({prompt})=>{prompts.push(prompt);return prompt.includes('生成中文精读指南')?JSON.stringify({overview:'恢复指南',highlights:[]}):JSON.stringify({blocks:[{id:'S002',translation:'恢复后的第二段'}]});}}});
  await restarted.start(); restarted.startReading(f.opened.key); await restarted.jobs.get(f.opened.key+':reading').promise;
  const result=restarted.snapshot(f.opened.key).reading;
  assert.equal(result.status,'complete'); assert.equal(result.blocks[0].translation,'已完成的第一段');
  assert.equal(prompts.filter(prompt=>prompt.includes('以下完整原文块')).length,1);
  await restarted.close();
});

test('问题先持久化，流式回答与稳定ID重试不重复，重启标记中断', async t => {
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{model:{run:async({onText})=>{onText('部分回答');await gate;return '完整回答';}}});
  await f.engine.ask(f.opened.key,{id:'message-1',question:'我的问题'});
  await f.engine.ask(f.opened.key,{id:'message-1',question:'重复网络提交'});
  for(let tries=0;tries<10 && f.engine.get(f.opened.key).chat[0].answer!=='部分回答';tries++)await new Promise(resolve=>setTimeout(resolve,10));
  await f.engine.saves.get(f.opened.key);
  const saved=JSON.parse(await readFile(path.join(f.engine.get(f.opened.key).directory,'document.json'),'utf8'));
  assert.equal(saved.chat.length,1); assert.equal(saved.chat[0].question,'我的问题'); assert.equal(saved.chat[0].answer,'部分回答');
  release();await f.engine.jobs.get(f.opened.key+':chat').promise;
  assert.equal(f.engine.snapshot(f.opened.key).chat[0].status,'complete');assert.equal(f.engine.snapshot(f.opened.key).busyChat,false);
  await f.engine.close();
});

test('引用 AI 回答的追问携带选段与完整上下文，拒绝跨文献消息',async t=>{
 const f=await fixture(t,{model:{run:async()=> '先前回答：这个结果需要核实。'}});
 await f.engine.ask(f.opened.key,{id:'prior-answer',question:'第一问'});await f.engine.jobs.get(f.opened.key+':chat').promise;
 let prompt='';f.engine.model={run:async input=>{prompt=input.prompt;return '模拟解释';}};
 await f.engine.ask(f.opened.key,{id:'follow-up',question:'为什么',selection:{origin:'conversation',kind:'conversation',recordId:'prior-answer',recordRole:'assistant',text:'这个结果需要核实'}});
 await f.engine.jobs.get(f.opened.key+':chat').promise;
 assert.match(prompt,/这个结果需要核实/);assert.match(prompt,/先前回答：这个结果需要核实。/);assert.match(prompt,/并非论文原文/);
 await f.engine.ask(f.opened.key,{id:'wrong-paper',question:'继续',selection:{origin:'conversation',recordId:'another-paper',text:'其他文献'}});
 await f.engine.jobs.get(f.opened.key+':chat').promise;assert.match(f.engine.get(f.opened.key).chat.at(-1).error,/不属于当前文献/);
 await f.engine.close();
});

test('混合扫描页显式保留OCR缺口，不能把部分原文标为全文完成', async t => {
  const f=await fixture(t,{source:{incomplete:true,ocrPages:[3],notes:['第3页需要OCR']}});
  f.engine.startReading(f.opened.key);await f.engine.jobs.get(f.opened.key+':reading').promise;
  const result=f.engine.snapshot(f.opened.key).reading;
  assert.equal(result.status,'interrupted');assert.match(result.error,/3/);assert.equal(result.blocks[0].translation,'译文 S001');
  await f.engine.close();
});

test('并发打开同一附件只发布一份文献状态', async t => {
  const f=await fixture(t), seen=new Set(), save=f.engine.save.bind(f.engine);
  f.engine.save=async doc=>{if(doc.paper.itemKey==='PAPER003')seen.add(doc);return save(doc);};
  const input={paper:{...paper,itemKey:'PAPER003'},pdfPath:f.pdf,attachmentKey:paper.attachmentKey};
  const snapshots=await Promise.all(Array.from({length:12},()=>f.engine.open(input)));
  assert.equal(new Set(snapshots.map(row=>row.key)).size,1);
  assert.equal(seen.size,1);
  const doc=f.engine.get(snapshots[0].key);doc.chat.push({id:'retained',question:'保留状态',answer:'',status:'error'});
  assert.equal((await f.engine.open(input)).chat[0].id,'retained');
  await f.engine.close();
});

test('无效导读保留已译正文并可继续，空条目不会污染归档契约', async t => {
  let bad=true, translations=0;
  const f=await fixture(t,{model:{run:async({prompt})=>{
    if(prompt.startsWith('为这张图表'))return '图表阅读提示（模拟响应）。';
    if(prompt.includes('生成中文精读指南'))return JSON.stringify(bad?{overview:'指南',highlights:[],readingOrder:{bad:true}}:{overview:'指南',readingOrder:['先读问题'],highlights:[null],glossary:[null,{term:'Alpha',translation:'阿尔法'}]});
    translations++;const input=JSON.parse(prompt.slice(prompt.indexOf('\n\n[')+2));return JSON.stringify({blocks:input.map(block=>({id:block.id,translation:'保留译文 '+block.id}))});
  }}});
  f.engine.startReading(f.opened.key);await f.engine.jobs.get(f.opened.key+':reading').promise;
  assert.equal(f.engine.snapshot(f.opened.key).reading.status,'error');
  assert.equal(f.engine.snapshot(f.opened.key).reading.blocks[0].translation,'保留译文 S001');
  assert.equal(f.engine.get(f.opened.key).guideDraft,undefined);
  assert.ok(f.engine.get(f.opened.key).rejectedGuideDraft);
  const count=translations;bad=false;f.engine.startReading(f.opened.key);await f.engine.jobs.get(f.opened.key+':reading').promise;
  const reading=f.engine.snapshot(f.opened.key).reading;
  assert.equal(reading.status,'complete');assert.equal(translations,count);
  assert.deepEqual(reading.guide.highlights,[]);assert.deepEqual(reading.guide.glossary,[{term:'Alpha',translation:'阿尔法'}]);
  await f.engine.close();
});
