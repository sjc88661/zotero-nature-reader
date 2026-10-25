import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessModel } from '../backend/harness.mjs';
import { mkdtemp,writeFile,unlink,rmdir,mkdir,readFile,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import { apply as startReaderPlugin } from '../backend/plugin.mjs';

test('多个 Harness 实例共用连接与文献写入者，主实例退出后自动接管',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'znr-owner-'));
  const skillRoot=path.join(root,'skills'),dshHome=path.join(root,'dsh'),workRoot=path.join(root,'work');
  const resources=['nature-reader/SKILL.md','nature-reader/static/core/principles.md','nature-reader/static/core/workflow.md',
    'nature-reader/static/core/output-contract.md','nature-reader/static/fragments/source/pdf-text.md',
    'nature-shared/core/terminology-ledger.md','nature-reader/references/grounding-rules.md'];
  const contexts=[];
  const context=()=>{
    const disposers=[];
    const ctx={effect(setup){const dispose=setup();disposers.push(dispose);return dispose;},
      logger:{warn(error){throw new Error(String(error));}},async close(){for(const dispose of disposers.splice(0).reverse())await dispose();}};
    contexts.push(ctx);return ctx;
  };
  const connectionFile=path.join(dshHome,'zotero-nature','connection.json');
  const connection=async()=>JSON.parse(await readFile(connectionFile,'utf8'));
  try {
    for(const resource of resources){const file=path.join(skillRoot,resource);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'Test-only Nature instructions.');}
    const config={dshHome,skillRoot,workRoot};
    const primary=context(),secondary=context();
    await startReaderPlugin(primary,config);const first=await connection();
    await startReaderPlugin(secondary,config);const second=await connection();
    assert.equal(second.url,first.url,'第二个实例不能覆盖连接端口');
    assert.equal(second.token,first.token,'第二个实例不能替换现有连接凭据');
    await primary.close();
    const deadline=Date.now()+7000;let replacement;
    while(Date.now()<deadline){
      try{replacement=await connection();if(replacement.token!==first.token)break;}catch(error){if(error.code!=='ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(replacement&&replacement.token!==first.token,'主实例退出后，等待实例应接管');
    const health=await new Promise((resolve,reject)=>{
      import('node:http').then(({get})=>get(replacement.url+'/health',{headers:{Authorization:'Bearer '+replacement.token}},response=>{
        let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve(JSON.parse(body)));
      }).on('error',reject),reject);
    });
    assert.equal(health.ok,true);
    await secondary.close();
    await assert.rejects(readFile(connectionFile,'utf8'),{code:'ENOENT'});
  } finally {
    for(const ctx of contexts)await ctx.close();
    const relative=path.relative(path.resolve(tmpdir()),path.resolve(root));
    if(!relative.startsWith('..')&&!path.isAbsolute(relative)&&relative.startsWith('znr-owner-'))await rm(root,{recursive:true,force:true});
  }
});

test('图像使用 Harness 持久附件传入模型；纯文字模型明确回退图注',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'znr-image-')),file=path.join(dir,'test.png');
  await writeFile(file,Buffer.from('image-fixture'));
  try {for(const visual of [true,false]){
    const listeners=new Map();let content,mode,saved=0;
    const ref={id:'image-ref',mediaType:'image/png'};
    const ctx={on(name,callback){listeners.set(name,callback);return()=>listeners.delete(name);},
      llm:{async resolveModelInfo(){return {inputModalities:visual?['text','image']:['text']};}},
      attachments:{async saveImages(images){saved++;assert.equal(images[0].data.toString(),'image-fixture');return [ref];}}};
    const agent={id:'figure-test',options:{provider:'mock',model:'mock'},status:'idle',cancel(){},followup(message){content=message.content;
      listeners.get('session/event')({id:this.id},{type:'assistant/message',data:{message:{content:[{type:'text',text:'解读'}]}}});
      listeners.get('session/event')({id:this.id},{type:'turn/end',data:{reason:{kind:'completed'}}});},async whenIdle(){}};
    const model=new HarnessModel({ctx,nature:{},timeoutMs:1000});model.handle=async()=>({agent});
    await model.run({doc:{},kind:'chat',prompt:'解释图一',images:[{sourcePath:file,mediaType:'image/png'}],signal:new AbortController().signal,onInputMode:value=>mode=value});
    assert.equal(mode,visual?'image':'caption');assert.equal(saved,visual?1:0);
    assert.equal(content.filter(b=>b.type==='image').length,visual?1:0);
    if(visual)assert.deepEqual(content[1].attachment,ref);else assert.match(content[0].text,/仅依据图注与正文/);
  }}finally{await unlink(file);await rmdir(dir);}
});

test('Harness 只把 completed 视为完整回答，其他结局保留已生成文本',async()=>{
  for(const reason of ['completed','aborted','blocked','error','max-tokens','interrupted']){
    const listeners=new Map();let partial='',flushed=false;
    const ctx={on(name,callback){listeners.set(name,callback);return()=>listeners.delete(name);},sessions:{async flush(){flushed=true;}}};
    const agent={id:'session-test',status:'idle',session:{},cancel(){},followup(){
      listeners.get('session/event')({header:{id:this.id}},{type:'assistant/message',data:{message:{content:[{type:'text',text:'已生成内容'}]}}});
      listeners.get('session/event')({header:{id:this.id}},{type:'turn/end',data:{reason:{kind:reason}}});
    },async whenIdle(){}};
    const model=new HarnessModel({ctx,nature:{},timeoutMs:1000});model.handle=async()=>({agent});
    const result=model.run({doc:{},kind:'chat',prompt:'模拟',signal:new AbortController().signal,onText:text=>{partial=text;}});
    if(reason==='completed')assert.equal(await result,'已生成内容');else await assert.rejects(result,/未完整结束/);
    assert.equal(partial,'已生成内容');assert.equal(flushed,reason==='completed');assert.equal(listeners.size,0);
  }
});

test('Nature 技能和指令通过独立注入作用域加载',async()=>{
  let mounted=false,loaded=false,prompt='';
  const model=new HarnessModel({ctx:{get:()=>({mount:async()=>{mounted=true;}})},nature:{skills:[{name:'nature-reader'}],reader:'已加载的技能核心'}});
  const agentCtx={get skills(){throw new Error('Cannot read skills without inject');},async inject(services,setup){
    assert.equal(mounted,true);assert.deepEqual(services,['skills','systemPrompt']);
    await setup({skills:{register(skill){loaded=skill.name==='nature-reader';}},systemPrompt:{section(value){prompt=value.text;}}});
  }};
  await model.setup(agentCtx);assert.equal(loaded,true);assert.ok(prompt.includes('已加载的技能核心'));
});

test('冷恢复文献会话保留会话 ID 并传入当前 Harness 模型配置',async()=>{
  const selection={provider:'configured-provider',model:'configured-model',reasoningEffort:'high'};
  for(const kind of ['chat','reading']){
    let resumed,created=false;
    const doc={sessions:{[kind]:'persisted-'+kind}};
    const ctx={agentDefaultModel:{currentSelection:()=>selection},agents:{get:()=>null,create(){created=true;},async resume(options){resumed=options;return {agent:{id:options.resumeSessionId,options:options.agentOptions}};}}};
    const model=new HarnessModel({ctx,nature:{}}),handle=await model.create(doc,kind);
    assert.equal(created,false);assert.equal(resumed.resumeSessionId,doc.sessions[kind]);
    assert.deepEqual(handle.agent.options,selection);assert.notEqual(handle.agent.options,selection);
    assert.equal(typeof resumed.setup,'function');
  }
});

test('组装提示词等发请求前错误从 turn/end 显示真实原因',async()=>{
  const detail='prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")';
  const listeners=new Map(),ctx={on(name,callback){listeners.set(name,callback);return()=>listeners.delete(name);}};
  const agent={id:'assembly-failure',status:'idle',cancel(){},followup(){listeners.get('session/event')({id:this.id},{type:'turn/end',data:{reason:{kind:'error',error:{message:detail,code:'UNKNOWN'}}}});},async whenIdle(){}};
  const model=new HarnessModel({ctx,nature:{}});model.handle=async()=>({agent});
  await assert.rejects(model.run({doc:{},kind:'chat',prompt:'test',signal:new AbortController().signal}),error=>error.message===detail);
  assert.equal(listeners.size,0);
});
