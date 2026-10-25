'use strict';
// Shares the paper's existing DSH chat/archive pipeline; owns only modal UI state.
window.ZNRFigureChat = (() => {
  const $=id=>document.getElementById(id), drafts=new Map(), messages=new Map();
  let api, figure=null, key='', selection=null, sending=false, recordCount=0;
  const context=()=>({kind:'figure',blockId:figure.id,page:figure.page,figureNote:false,text:`已附图表 ${figure.id} · 第 ${figure.page} 页（完整原图与图注）`});
  function remember(){if(key)drafts.set(key,{text:$('figure-question').value,selection,scrollTop:$('figure-captions').scrollTop});}
  function open(block){
    remember();figure=block;key=api.state().key+':'+block.id;const draft=drafts.get(key);
    selection=draft?.selection||context();$('figure-question').value=draft?.text||'';sending=false;recordCount=0;messages.clear();$('figure-messages').replaceChildren();render(api.state());
  }
  function quote(){
    const quoted=!!selection?.origin||!!selection?.segments?.length;
    const origin=selection?.origin==='reading-note'?'引用图解':selection?.origin==='conversation'?'引用对话':'引用图注';
    $('figure-chat-label').textContent=`${quoted?origin:'图表'} ${figure.id} · 第 ${figure.page} 页`;
    $('figure-chat-quote').textContent=quoted?selection.text:'完整原图与图注';
    $('figure-chat-quote').title=quoted?selection.text:'完整原图与图注会作为本次提问的上下文';
    $('figure-chat-clear').hidden=!quoted;
  }
  function records(state){return (state.chat||[]).filter(r=>r.selection?.blockId===figure?.id||r.question?.startsWith(`[${figure?.id} p.${figure?.page}]`));}
  function render(state){
    if(!figure)return;quote();
    if(state.busyChat||state.error)sending=false;
    const rows=records(state), scroller=$('figure-captions'), follow=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<100;
    const keep=new Set();
    for(const record of rows){
      keep.add(record.id);let item=messages.get(record.id);
      const stamp=JSON.stringify([record.answer,record.question,record.status,record.error]);
      if(item?.stamp===stamp)continue;
      const node=item?.node||ZNR.element('article',undefined,'figure-chat-message');
      // Preserve a selected passage while a different reply streams.
      if(window.getSelection()?.toString()&&node.contains(window.getSelection().anchorNode))continue;
      node.replaceChildren();node.dataset.recordId=record.id;
      node.append(ZNR.element('div','我','role'),ZNR.element('div',record.question,'figure-chat-question'));
      const answer=ZNR.element('div',undefined,'figure-chat-answer');answer.dataset.recordId=record.id;answer.dataset.recordRole='assistant';
      ZNR.markdown(answer,record.answer|| (record.status==='pending'?'正在准备原文材料…':record.status==='streaming'?'正在思考与生成…':''));
      node.append(ZNR.element('div','NATURE · DSH','role'),answer);
      const labels={pending:'问题已保存，正在准备',streaming:'正在回答 · 自动保存中',complete:'已完成 · 自动归档',interrupted:'已停止 · 已生成内容保留',error:'回答遇到问题'};
      node.append(ZNR.element('div',record.error||labels[record.status]||'','small muted'));
      if(['error','interrupted'].includes(record.status)){
        const retry=ZNR.element('button','重试回答','text-button');retry.disabled=!!state.busyChat;
        retry.addEventListener('click',()=>{sending=true;api.action('chat',{id:record.id,question:record.question,retry:true});render(api.state());});node.append(retry);
      }
      if(!item)$('figure-messages').append(node);messages.set(record.id,{node,stamp});
    }
    for(const [id,item] of messages)if(!keep.has(id)){item.node.remove();messages.delete(id);}
    $('figure-chat-empty').hidden=!!rows.length;
    const ownBusy=rows.some(r=>['pending','streaming'].includes(r.status)),busy=!!state.busyChat||sending;
    $('figure-chat-send').disabled=busy||!$('figure-question').value.trim();$('figure-chat-stop').hidden=!ownBusy;
    $('figure-chat-status').textContent=state.error||state.archiveError|| (ownBusy?'正在回答 · 自动保存中':sending?'正在准备原文材料…':busy?'本篇正在回答另一条问题，请稍后再试。':'讨论自动保存到 Obsidian');
    $('figure-chat-form').dataset.state=state.error||state.archiveError?'error':busy?'busy':'ready';
    if(api.active()&&(follow||rows.length>recordCount))scroller.scrollTop=scroller.scrollHeight;recordCount=rows.length;
  }
  function ask(value=null,prompt='',immediate=false){
    selection={...(value||context()),kind:'figure',blockId:figure.id,page:figure.page,figureNote:!!value?.figureNote};
    api.tab('chat');if(prompt)$('figure-question').value=prompt;quote();render(api.state());$('figure-question').focus({preventScroll:true});
    if(immediate)$('figure-chat-form').requestSubmit();
  }
  function capture(){
    if(!figure||!$('figure-viewer').open)return null;
    const s=window.getSelection();if(!s?.rangeCount||s.isCollapsed)return null;
    const r=s.getRangeAt(0),node=(r.startContainer.nodeType===Node.ELEMENT_NODE?r.startContainer:r.startContainer.parentElement).closest('.figure-chat-answer');
    if(!node||!node.contains(r.endContainer)||!s.toString().trim())return null;
    return {kind:'figure',origin:'conversation',recordId:node.dataset.recordId,recordRole:'assistant',blockId:figure.id,page:figure.page,figureNote:false,text:s.toString().trim()};
  }
  function init(value){
    api=value;
    $('figure-question').addEventListener('input',()=>{remember();render(api.state());});
    $('figure-question').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('figure-chat-form').requestSubmit();}});
    $('figure-chat-form').addEventListener('submit',e=>{
      e.preventDefault();const question=$('figure-question').value.trim();if(!question||sending||api.state().busyChat||!figure)return;
      sending=true;api.action('chat',{id:crypto.randomUUID(),question,selection:selection||context()});$('figure-question').value='';selection=context();remember();render(api.state());
    });
    $('figure-chat-clear').addEventListener('click',()=>{selection=context();quote();remember();});
    $('figure-chat-stop').addEventListener('click',()=>api.action('cancel',{kind:'chat'}));
    $('figure-chat-back').addEventListener('click',()=>api.tab('note'));
  }
  return {init,open,ask,render,remember,capture};
})();
