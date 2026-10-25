'use strict';
window.ZNRPanelSelection=(()=>{
  let current,selected=null,toolbar;
  function reset(){selected=null;if(toolbar)toolbar.hidden=true;}
  function capture(){
    const selection=window.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return null;
    const range=selection.getRangeAt(0),anchor=range.commonAncestorContainer;
    const node=(anchor.nodeType===Node.ELEMENT_NODE?anchor:anchor.parentElement)?.closest('.message-body[data-record-id],.generated-text');
    const text=selection.toString().trim();if(!node||!text)return null;
    const state=current();if(!state.key)return null;
    if(node.dataset.language==='readingNote')return {text,kind:'figure',origin:'reading-note',blockId:node.dataset.blockId,page:Number(node.dataset.page),figureNote:false};
    const record=state.chat?.find(r=>r.id===node.dataset.recordId);if(!record)return null;
    return {text,kind:'conversation',origin:'conversation',recordId:record.id,recordRole:node.dataset.recordRole,
      ...(record.selection?.kind==='figure'?{kind:'figure',blockId:record.selection.blockId,page:record.selection.page,figureNote:false}:{})};
  }
  function init(getState){
    current=getState;toolbar=ZNR.element('div',undefined,'selection-tools panel-selection-tools');toolbar.id='panel-selection-tools';toolbar.hidden=true;toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','对话选段操作');
    for(const [type,label] of [['ask','追问选段'],['explain','解释选段'],['copy','复制']]){
      const button=ZNR.element('button',label);button.dataset.panelSelection=type;
      button.addEventListener('click',()=>{
        if(!selected)return;const selection=selected;toolbar.hidden=true;
        if(type==='copy')ZNR.action('copy',{paperKey:current().key,text:selection.text});
        else ZNR.action('selection',{paperKey:current().key,selection,intent:type,prompt:type==='explain'?'请解释这段话的含义，并结合论文核查它的依据与局限。':''});
      });toolbar.append(button);
    }
    toolbar.addEventListener('pointerdown',e=>e.preventDefault());document.body.append(toolbar);
    const changed=e=>{
      if(e.target?.closest?.('#panel-selection-tools,#chat-form'))return;
      selected=capture();if(!selected){toolbar.hidden=true;return;}
      const rect=window.getSelection().getRangeAt(0).getBoundingClientRect();toolbar.hidden=false;
      toolbar.style.left=Math.max(6,Math.min(innerWidth-toolbar.offsetWidth-6,rect.left))+'px';
      toolbar.style.top=Math.max(6,Math.min(innerHeight-toolbar.offsetHeight-6,rect.bottom+6))+'px';
    };
    document.addEventListener('mouseup',changed);
    document.addEventListener('keyup',e=>{if(e.key==='Shift'||e.key.startsWith('Arrow'))changed(e);if(e.key==='Escape')reset();});
    document.getElementById('tab-body').addEventListener('scroll',()=>{toolbar.hidden=true;});
  }
  return {init,reset};
})();
