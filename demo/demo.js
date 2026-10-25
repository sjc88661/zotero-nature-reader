'use strict';
(async()=>{
  const panel=document.getElementById('panel'),reader=document.getElementById('reader');
  await Promise.all([panel,reader].map(f=>f.contentDocument?.documentURI?.startsWith(location.origin+'/content/')&&f.contentDocument.readyState==='complete'?Promise.resolve():new Promise(r=>f.addEventListener('load',r,{once:true}))));
  const state=await fetch('/demo/state.json').then(r=>r.json());
  let selected=null,timer=null;window.demoState=state;
  function push(){
    const side={...state,reading:{...state.reading,figureNotes:state.reading.blocks.filter(b=>b.asset).map(b=>({blockId:b.id,page:b.page,note:b.readingNote}))},selected};
    panel.contentDocument.dispatchEvent(new panel.contentWindow.CustomEvent('znr-state',{detail:JSON.stringify(side)}));
    reader.contentDocument.dispatchEvent(new reader.contentWindow.CustomEvent('znr-state',{detail:JSON.stringify(state)}));
  }
  function toast(text){const n=document.getElementById('demo-toast');n.textContent=text;n.hidden=false;setTimeout(()=>n.hidden=true,3000);}
  async function scene(name){
    document.body.dataset.scene=name;document.querySelectorAll('[data-scene]').forEach(b=>b.classList.toggle('active',b.dataset.scene===name));
    if(['figure','chat'].includes(name)){
      await reader.contentWindow.ZNRTools.openFigure(state.reading.blocks.find(b=>b.id==='F001'));
      reader.contentDocument.getElementById('figure-tab-'+(name==='chat'?'chat':'note')).click();
    }else{
      const dialog=reader.contentDocument.getElementById('figure-viewer');if(dialog.open)dialog.close();
      if(name==='guide')panel.contentDocument.querySelector('[data-tab="guide"]').click();
      else panel.contentDocument.querySelector('[data-tab="highlights"]').click();
      panel.contentDocument.getElementById('tab-body').scrollTop=0;
    }
  }
  window.demoScene=scene;
  async function handle(message){
    const {action}=message;
    if(action==='appearance'){Object.assign(state.appearance,message.appearance);push();}
    else if(action==='position'){}
    else if(action==='toggle-sidebar'){state.sidebarCollapsed=!state.sidebarCollapsed;document.querySelector('.demo-workspace').style.gridTemplateColumns=state.sidebarCollapsed?'0 minmax(0,1fr)':'';push();}
    else if(action==='selection'){
      selected=message.selection;state.panelCommand={id:Date.now(),tab:'chat',prompt:message.prompt||'',focus:true};push();
      if(message.intent==='explain')handle({action:'chat',question:message.prompt||'解释这段内容',selection:selected});
    }
    else if(action==='locate'){state.navigation={id:Date.now(),blockId:message.blockId,openFigure:!!message.openFigure};if(message.openFigure)document.body.dataset.scene='figure';push();}
    else if(action==='source'){toast('演示页面：正式插件会在 Zotero 中定位到对应原文。');}
    else if(action==='open-note'){location.href='/note';}
    else if(action==='chat'){
      if(state.busyChat)return;const id=message.id||crypto.randomUUID();const context=Object.hasOwn(message,'selection')?message.selection:selected;
      const record=state.chat.find(r=>r.id===id)||{source:'dsh',id,createdAt:Date.now(),question:message.question,answer:'',selection:context};
      if(!state.chat.includes(record))state.chat.push(record);record.status='streaming';record.answer='';record.updatedAt=Date.now();state.busyChat=true;selected=null;push();
      const reply='**演示回答（预置）**\n\n先明确问题，再核对方法与证据。图表可以帮助组织比较，但解释仍要回到原文。\n\n- 确认横轴、纵轴和比较条件。\n- 核对误差线、重复与归一化的定义。\n- 把观察、推论和待核实事项分别记录。[S008 p.2]\n\n本演示未调用模型，也未写入真实笔记库。';let end=0;
      clearInterval(timer);timer=setInterval(()=>{end+=18;record.answer=reply.slice(0,end);record.updatedAt=Date.now();if(end>=reply.length){clearInterval(timer);record.status='complete';state.busyChat=false;}push();},120);
    }
    else if(action==='cancel'){clearInterval(timer);state.busyChat=false;const r=state.chat.findLast(r=>r.status==='streaming');if(r)r.status='interrupted';push();}
    else if(action==='annotation-create'){
      state.annotations.push({key:'DEMO-'+Date.now(),color:message.color,segments:message.selection.segments,operationId:message.operationId,editable:true,displayComment:message.comment,paragraphRefs:[]});state.annotationStatus='演示标注保留在当前页面';push();
    }
    else if(action==='annotation-edit'){const row=state.annotations.find(r=>r.key===message.key);if(message.remove)state.annotations=state.annotations.filter(r=>r.key!==message.key);else if(row)Object.assign(row,{color:message.color,displayComment:message.comment});push();}
    else if(action==='copy'){await navigator.clipboard.writeText(message.text);toast('已复制');}
    else if(['generate','settings','reconnect'].includes(action)){toast('演示数据已准备好；正式使用请按安装指南连接 Harness。');}
    else if(action==='mode'){toast('演示使用双语内容；正式插件可切回原 PDF。');}
  }
  for(const f of [panel,reader])f.contentDocument.addEventListener('znr-action',e=>handle(JSON.parse(e.detail)).catch(()=>toast('演示操作暂未完成')));
  document.querySelectorAll('[data-scene]').forEach(b=>b.onclick=()=>scene(b.dataset.scene));
  push();await scene(new URLSearchParams(location.search).get('view')||'overview');window.demoReady=true;
})();
