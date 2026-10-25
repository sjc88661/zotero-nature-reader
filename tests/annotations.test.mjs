import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
const code=await readFile(new URL('../addon/content/annotations.js',import.meta.url),'utf8');
const textCode=await readFile(new URL('../addon/content/selection-text.js',import.meta.url),'utf8');
function fixture(){
 const files=new Map(),items=new Map();let number=0, syncs=0;
 const attachment={id:1,libraryID:1,key:'ATTACH01',isPDFAttachment:()=>true,isEditable:()=>true,getAnnotations:()=>[...items.keys()]};
 class Item {
  constructor(){this.json={};}
  async loadPrimaryData(){} _requireData(){} isEditable(){return !this.json.readOnly;}
  setTags(tags){this.json.tags=tags.map(t=>({name:t.tag}));}
  async save(){if(++fault.saves===fault.failSave)throw new Error('injected save failure');this.id=this.key;this.json.key=this.key;items.set(this.key,this);}
  async erase(){if(++fault.erases===fault.failErase)throw new Error('injected erase failure');items.delete(this.key);}
  async reload(){} async eraseTx(){return this.erase();}
 }
 const fault={saves:0,erases:0,failSave:Infinity,failErase:Infinity};
 for(const [field,name] of Object.entries({annotationType:'type',annotationAuthorName:'authorName',annotationText:'text',annotationComment:'comment',annotationColor:'color',annotationPageLabel:'pageLabel',annotationSortIndex:'sortIndex',annotationIsExternal:'isExternal'}))Object.defineProperty(Item.prototype,field,{get(){return this.json[name];},set(value){this.json[name]=value;}});
 Object.defineProperty(Item.prototype,'annotationPosition',{get(){return JSON.stringify(this.json.position);},set(value){this.json.position=JSON.parse(value);}});
 attachment.reload=async()=>{};
 const Zotero={Item,DB:{executeTransaction:async work=>{const before=[...items].map(([key,item])=>[key,{json:structuredClone(item.json),libraryID:item.libraryID,parentID:item.parentID}]);try{return await work();}catch(error){items.clear();for(const [key,saved]of before){const item=new Item();Object.assign(item,saved,{key,id:key});items.set(key,item);}throw error;}}},Notifier:{registerObserver:()=>1,unregisterObserver(){}},DataObjectUtilities:{generateKey:()=>String(++number).padStart(8,'A')},Items:{loadDataTypes:async()=>{},getAsync:async ids=>Array.isArray(ids)?ids.map(id=>items.get(id)).filter(Boolean):items.get(ids),getByLibraryAndKey:(_lib,key)=>items.get(key),getByLibraryAndKeyAsync:async(_lib,key)=>items.get(key)},Annotations:{toJSONSync:item=>structuredClone(item.json)}};
 const context={module:{exports:{}},Zotero,PathUtils:path,IOUtils:{exists:async p=>files.has(p),readUTF8:async p=>files.get(p),writeUTF8:async(p,t)=>files.set(p,t)}}; vm.runInNewContext(textCode,context);vm.runInNewContext(code,context);
 const blocks=[{id:'S001',page:1,order:0,original:'Alpha beta.',translation:'甲乙测试。'},{id:'S002',page:2,order:1,original:'Gamma delta.',translation:'第二段。'}];
 const layout={version:1,fingerprint:'a'.repeat(64),coordinateSystem:'pdf-unrotated-bottom-left',status:'ready',blocks:Object.fromEntries(blocks.map((b,i)=>[b.id,{mapped:true,chars:[...b.original].map((c,j)=>({start:j,end:j+1,line:i,rect:[10+j*5,20,15+j*5,30]}))}]))};
 const snapshot={fingerprint:'a'.repeat(64),layout,reading:{blocks}};
 const binding={key:'paper-key',paper:{libraryID:1,itemKey:'PAPER001',attachmentKey:'ATTACH01'},reader:{_item:attachment}};
 const bridge={annotations:{sync:async()=>{syncs++;}},store:{state:{notes:{'1:PAPER001':{dirty:false}}}}};
 const runtime={directory:'memory',win:{setTimeout,clearTimeout},bindings:new Map([[binding.reader,binding]]),known:new Map([[binding.key,{snapshot}]]),emit(){},log(error){throw error;},bridge:()=>bridge,safe:fn=>fn()};
 const manager=new context.module.exports.Annotations(runtime); runtime.annotations=manager;
 return {manager,binding,items,files,runtime,fault,core:context.module.exports,snapshot,get syncs(){return syncs;}};
}

test('图解精确选段保存原生批注，修改撤销恢复；不伪造原文高亮',async()=>{
 const f=fixture();f.snapshot.layout.pages={'1':{cropBox:[20,30,620,830],rotation:90}};
 const sourceText='主要结果四条染色体。';
 f.snapshot.reading.blocks.push({id:'F001',page:1,order:3,asset:'figure.png',original:'',translation:'',readingNote:{text:'**主要结果**\n\n四条染色体。'}});
 const segment={blockId:'F001',language:'readingNote',sourceText,start:4,end:9,text:'四条染色体'};
 await f.manager.start();await f.manager.create(f.binding,{operationId:'figure-note',selection:{segments:[segment]},comment:'需要核实',color:'#2ea8e5'});
 const item=[...f.items.values()][0];assert.equal(item.json.type,'note');assert.equal(item.json.text,'');assert.match(item.json.comment,/AI 图表解读选段（非论文原文）/);assert.match(item.json.comment,/四条染色体\n\n需要核实/);
 assert.deepEqual([...item.json.position.rects[0]],[26,802,48,824]);
 await f.manager.refresh();assert.equal(f.manager.rows.get('paper-key')[0].segments[0].sourceText,sourceText);
 await f.manager.edit(f.binding,{key:item.key,comment:'已核实',color:'#a28ae5'});assert.match(item.json.comment,/已核实$/);
 await f.manager.edit(f.binding,{key:item.key,remove:true});assert.equal(f.items.size,0);await f.manager.undo(f.binding);assert.equal(f.items.size,1);
 await f.manager.stop();const restarted=new f.core.Annotations(f.runtime);f.runtime.annotations=restarted;await restarted.start();await restarted.refresh();
 assert.equal(restarted.rows.get('paper-key')[0].segments[0].text,'四条染色体');
 f.snapshot.reading.blocks.at(-1).readingNote.text+='解读已更新';
 await assert.rejects(()=>restarted.create(f.binding,{operationId:'stale',selection:{segments:[segment]}}),/解读已变化/);
 await restarted.stop();
});
test('英文精确/中文段落标注；跨页创建幂等，修改删除撤销和重启恢复',async()=>{
 const f=fixture();await f.manager.start();
 const selection={segments:[{blockId:'S001',language:'original',start:0,end:5,text:'Alpha'},{blockId:'S002',language:'translation',start:0,end:3,text:'第二段'}]};
 await f.manager.create(f.binding,{operationId:'testop',selection,comment:'理解',color:'#2ea8e5'});
 assert.equal(f.items.size,2);const created=[...f.items.values()];
 assert.equal(created[0].json.text,'Alpha');assert.equal(created[0].json.position.rects[0][2],35);
 assert.equal(created[1].json.text,'Gamma delta.');assert.match(created[1].json.comment,/中文选段，原文按段落定位：\n第二段\n\n理解/);assert.equal(created[1].json.position.pageIndex,1);
 await f.manager.create(f.binding,{operationId:'testop',selection});assert.equal(f.items.size,2);
 const second=created[1].key;await f.manager.edit(f.binding,{key:second,comment:'新批注',color:'#a28ae5'});assert.match(f.items.get(second).json.comment,/第二段\n\n新批注/);
 await f.manager.edit(f.binding,{key:second,remove:true});assert.equal(f.items.size,1);await f.manager.undo(f.binding);assert.equal(f.items.size,2);
 await f.manager.stop();const reloaded=new f.core.Annotations(f.runtime);f.runtime.annotations=reloaded;await reloaded.start();await reloaded.refresh();
 assert.equal(reloaded.rows.get('paper-key').find(row=>row.key===second).segments[0].language,'translation');
 await reloaded.undo(f.binding);assert.match(f.items.get(second).json.comment,/理解$/);await reloaded.undo(f.binding);assert.equal(f.items.size,0);
 assert.ok(f.syncs>=6);await reloaded.stop();
});
test('过期选区和未定位段落不创建任何标注，原生标注可反查英文范围',()=>{
 const f=fixture();assert.throws(()=>f.core.selectionParts(f.snapshot,{segments:[{blockId:'S001',language:'original',start:0,end:5,text:'Wrong'}]}),/选区已变化/);
 const rows=f.core.rangesFromRects(f.snapshot,{pageIndex:0,rects:[[10,20,35,30]]});assert.equal(rows[0].start,0);assert.equal(rows[0].end,5);
 f.snapshot.layout.blocks.S001.mapped=false;assert.throws(()=>f.core.selectionParts(f.snapshot,{segments:[{blockId:'S001',language:'original',start:0,end:5,text:'Alpha'}]}),/可靠文字坐标/);
 assert.equal(f.items.size,0);
});
test('撤销保留之后的原生修改；中文批注前缀被手动移除后不再自动补回；原生跨页高亮映射',async()=>{
 const f=fixture();await f.manager.start();
 await f.manager.create(f.binding,{operationId:'conflict',selection:{segments:[{blockId:'S001',language:'translation',start:0,end:2,text:'甲乙'}]},comment:'初始'});
 const item=[...f.items.values()][0];item.json.comment='在原生界面重新写的批注';
 await assert.rejects(f.manager.undo(f.binding),/此后已在 Zotero 中修改/);assert.equal(f.items.size,1);
 await f.manager.edit(f.binding,{key:item.key,comment:'再次修改'});assert.equal(f.items.get(item.key).json.comment,'再次修改');
 const ranges=f.core.rangesFromRects(f.snapshot,{pageIndex:0,rects:[[10,20,35,30]],nextPageRects:[[10,20,35,30]]});
 assert.deepEqual(new Set(ranges.map(r=>r.blockId)),new Set(['S001','S002']));await f.manager.stop();
});

test('多段创建和撤销失败均原子回滚；重试不重复',async()=>{
 const f=fixture();await f.manager.start();const request={operationId:'atomic',selection:{segments:[{blockId:'S001',language:'original',start:0,end:5,text:'Alpha'},{blockId:'S002',language:'translation',start:0,end:3,text:'第二段'}]}};
 f.fault.failSave=2;await assert.rejects(f.manager.create(f.binding,request),/injected save/);assert.equal(f.items.size,0);
 f.fault.failSave=Infinity;await f.manager.create(f.binding,request);assert.equal(f.items.size,2);
 f.fault.failErase=2;await assert.rejects(f.manager.undo(f.binding),/injected erase/);assert.equal(f.items.size,2);
 f.fault.failErase=Infinity;await f.manager.undo(f.binding);assert.equal(f.items.size,0);await f.manager.stop();
});
