import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessModel } from '../backend/harness.mjs';
import { mkdtemp,writeFile,unlink,rmdir } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

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
