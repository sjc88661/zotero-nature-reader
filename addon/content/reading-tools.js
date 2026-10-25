'use strict';
window.ZNRTools = (() => {
  const $ = id => document.getElementById(id);
  const colors = ['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5', '#e56eee', '#f19837', '#aaaaaa'];
  let api, selected = null, editing = null, color = colors[0], figure = null, scale = 1, fitScale = 1, figurePosition = null, focusBefore = null, operationId = null, notice = '', figureNoteStamp = '';
  let figureTab = 'note', figureSplit = 55, figureFontSize = 17, zoomMode = 'all', figureViewKey = '', figureOpenToken = 0;
  let tabPositions = { note: 0, caption: 0, chat: 0, annotations: 0 };
  const figureViews = new Map();
  const uid = () => window.crypto.randomUUID();
  const action = (name, data = {}) => ZNR.action(name, { paperKey: api.state().key, ...data });
  function feedback(text) { notice = text; $('feedback-text').textContent = text; $('reader-feedback').hidden = !text; if ($('figure-viewer').open) $('figure-save-status').textContent = text || '选段与批注自动同步到 Obsidian'; }
  function capture() {
    const conversation=ZNRFigureChat.capture(); if(conversation)return conversation;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0), segments = [];
    for (const node of document.querySelectorAll('.source-block > .original,.source-block > .translation,.source-part,.generated-text[data-language="readingNote"]')) {
      if (!node.getClientRects().length || node.closest('details:not([open])') || !range.intersectsNode(node)) continue;
      const local = document.createRange(); local.selectNodeContents(node);
      if (range.compareBoundaryPoints(Range.START_TO_START, local) > 0) local.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, local) < 0) local.setEnd(range.endContainer, range.endOffset);
      if (local.collapsed || !local.toString().trim()) continue;
      const before = document.createRange(); before.selectNodeContents(node); before.setEnd(local.startContainer, local.startOffset);
      const start = before.toString().length + Number(node.dataset.sourceOffset || 0), text = local.toString(), block = node.closest('.source-block');
      const generated=node.dataset.language==='readingNote';
      segments.push({ blockId: generated?node.dataset.blockId:node.dataset.sourceId||block.dataset.id, page: Number(generated||node.dataset.sourceId?node.dataset.page:block.dataset.page), language: generated?'readingNote':node.classList.contains('translation') ? 'translation' : 'original', start, end: start + text.length, text,
        ...(generated?{sourceText:node.textContent}:{}) });
    }
    if (!segments.length) return null;
    const generated=segments.every(s=>s.language==='readingNote');
    return { text: segments.map(s => s.text).join('\n\n'), blockId: segments[0].blockId, page: segments[0].page, segments,
      ...(generated?{kind:'figure',origin:'reading-note',figureNote:false}:{}) };
  }
  function restoreSelection(saved) {
    if (!saved?.segments?.length) return;
    const point = (segment, offset) => {
      const parent = segment.language==='readingNote'
        ? [...document.querySelectorAll('.generated-text')].find(n=>n.dataset.blockId===segment.blockId&&n.closest('#figure-viewer')?.open)
          ||document.getElementById('source-'+segment.blockId)?.querySelector('.generated-text')
        : ($('figure-viewer').open && [...$('figure-caption-panel').querySelectorAll('.source-block')].find(n=>n.dataset.id===segment.blockId)?.querySelector(':scope > .' + segment.language))
          || [...document.querySelectorAll('.source-part')].find(n=>n.dataset.sourceId===segment.blockId&&n.dataset.language===segment.language
            &&offset>=Number(n.dataset.sourceOffset||0)&&offset<=Number(n.dataset.sourceOffset||0)+n.textContent.length)
          || document.getElementById('source-' + segment.blockId)?.querySelector(':scope > .' + segment.language);
      if (!parent) return null;
      offset=Math.max(0,offset-Number(parent.dataset.sourceOffset||0));
      const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) { if (offset <= node.length) return [node, offset]; offset -= node.length; } return null;
    };
    const first = saved.segments[0], last = saved.segments.at(-1), start = point(first, first.start), end = point(last, last.end);
    if (!start || !end) return;
    const range = document.createRange(); range.setStart(...start); range.setEnd(...end); window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  }
  function place(element, rect) {
    element.hidden = false;
    const w = element.offsetWidth, h = element.offsetHeight;
    element.style.left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + Math.min(rect.width, w) / 2 - w / 2)) + 'px';
    element.style.top = Math.max(64, Math.min(innerHeight - h - 8, rect.bottom + 8)) + 'px';
  }
  function selectColor(value) {
    color = /^#[a-f0-9]{6}$/i.test(value || '') ? value : colors[0];
    for (const button of $('annotation-colors').children) button.setAttribute('aria-pressed', String(button.dataset.color === color));
  }
  function openEditor(annotation = null, rect = { left: innerWidth / 2 - 170, width: 340, bottom: 140 }) {
    ($('figure-viewer').open ? $('figure-viewer') : document.body).append($('annotation-editor'));
    editing = annotation;
    $('annotation-title').textContent = annotation ? '编辑标注' : '保存标注';
    $('annotation-quote').textContent = annotation ? (annotation.segments || []).map(s => s.text || api.state().reading?.blocks.find(b => b.id === s.blockId)?.[s.language]?.slice(s.start, s.end) || '').join('\n').slice(0, 400) : selected?.text.slice(0, 400) || '';
    const hasChinese = (annotation?.segments || selected?.segments || []).some(s => s.language === 'translation');
    const generated=(annotation?.segments||selected?.segments||[]).some(s=>s.language==='readingNote');
    const chineseGroups=new Map();
    for(const segment of annotation?.segments||selected?.segments||[])if(segment.language==='translation'){
      if(!chineseGroups.has(segment.blockId))chineseGroups.set(segment.blockId,[]);chineseGroups.get(segment.blockId).push(segment);
    }
    const mappings=annotation?(annotation.mapping?[annotation.mapping]:[]):[...chineseGroups].map(([id,segments])=>ZNRSentenceAlignment.resolve(api.state().reading?.blocks.find(b=>b.id===id),segments));
    const unresolved=mappings.some(m=>m.mode==='unresolved'),legacy=annotation&&hasChinese&&!annotation.mapping;
    $('annotation-hint').textContent = generated ? '高亮保留在 AI 图解中；原 PDF 保存关联图表的批注，选段及批注同步到 Obsidian。' : hasChinese
      ? legacy?'此旧标注仍按段落定位；已修改的原生标注不会自动移动。':unresolved?'未能可靠匹配英文句子。中文保留精确高亮，PDF 保存定位批注，不扩大为整段高亮。':'中文保留精确选区，PDF 高亮下面的对应英文句子（非逐字对齐）。请核对后保存。'
      : '保存为 Zotero 原生高亮，并自动同步到 Obsidian。';
    $('annotation-source-preview').hidden=!hasChinese||!mappings.some(m=>m.text);
    $('annotation-source-text').textContent=mappings.filter(m=>m.text).map(m=>m.text).join('\n\n');
    $('annotation-comment').value = annotation?.displayComment || '';
    $('annotation-remove').hidden = !annotation; $('annotation-source').hidden = !annotation;
    $('annotation-save').disabled = annotation?.editable === false;
    $('annotation-remove').disabled = annotation?.editable === false;
    $('annotation-comment').readOnly = annotation?.editable === false;
    selectColor(annotation?.color || colors[0]); place($('annotation-editor'), rect);
    $('selection-tools').hidden = true;
  }
  function editByKeys(keys, rect) {
    const annotations = (api.state().annotations || []).filter(row => keys.includes(row.key));
    if (!annotations.length) return;
    const choice = $('annotation-choice'); choice.replaceChildren(); choice.hidden = annotations.length < 2;
    for (const row of annotations) { const option = ZNR.element('option', (row.displayComment || row.comment || '高亮 ' + row.key).slice(0, 60)); option.value = row.key; choice.append(option); }
    openEditor(annotations[0], rect);
  }
  function update(next) {
    if($('figure-viewer').open&&figure){
      figure=next.reading?.blocks.find(b=>b.id===figure.id)||figure;
      renderFigureContent(next);
      ZNRFigureChat.render(next);
      $('figure-undo').hidden = !next.canUndo;
      $('figure-save-status').textContent = next.error || next.annotationStatus || '选段与批注自动同步到 Obsidian';
    }
    const text = next.error || next.annotationStatus || (next.layout?.status === 'pending' ? '正在本地准备文字定位与原文字体，现有内容可继续阅读。' : next.layout?.status === 'error' ? '文字定位准备未完成，可重试；现有译文保持不变。' : notice);
    if (next.error || next.annotationStatus || next.layout?.status !== 'ready') feedback(text);
    $('undo-annotation').hidden = !next.canUndo; $('retry-layout').hidden = next.layout?.status !== 'error';
    if (next.error) $('annotation-save').disabled = false;
    if (operationId && (next.annotations || []).some(row => row.operationId === operationId)) { operationId = null; selected = null; }
    if (editing && !(next.annotations || []).some(row => row.key === editing.key)) $('annotation-editor').hidden = true;
  }
  function reset() {
    selected = null; editing = null; operationId = null; notice = '';
    for (const id of ['selection-tools', 'annotation-editor', 'reader-feedback']) $(id).hidden = true;
    if ($('figure-viewer').open) $('figure-viewer').close();
    figureOpenToken++; figure = null;
  }
  function figureZoom(next, mode = 'manual') {
    zoomMode = mode;
    const stage = $('figure-stage'), image = $('figure-image'), oldWidth = image.width || image.naturalWidth;
    const centerX = (stage.scrollLeft + stage.clientWidth / 2 - 24) / oldWidth, centerY = (stage.scrollTop + stage.clientHeight / 2 - 24) / oldWidth;
    scale = Math.max(.01, Math.min(6, next));
    image.style.width = image.naturalWidth * scale + 'px'; image.style.height = image.naturalHeight * scale + 'px';
    $('figure-scale').textContent = Math.round(scale * 100) + '%';
    $('figure-fit').setAttribute('aria-pressed', String(mode === 'all')); $('figure-fit-width').setAttribute('aria-pressed', String(mode === 'width'));
    if(mode === 'all'){stage.scrollTop = 0; stage.scrollLeft = 0;}
    else if(stage.scrollTop || stage.scrollLeft){stage.scrollTop = centerY * image.width - stage.clientHeight / 2 + 24; stage.scrollLeft = centerX * image.width - stage.clientWidth / 2 + 24;}
  }
  function fitFigure(mode = 'all') {
    const image = $('figure-image'), stage = $('figure-stage');
    if (!$('figure-viewer').open || !image.naturalWidth || !image.naturalHeight) return;
    fitScale = mode === 'width' ? (stage.clientWidth - 48) / image.naturalWidth : Math.min(1, (stage.clientWidth - 48) / image.naturalWidth, (stage.clientHeight - 48) / image.naturalHeight);
    figureZoom(fitScale, mode);
  }
  function setFigureSplit(value, persist = false) {
    const width = $('figure-split').clientWidth - 12; if(width <= 0) return;
    const min = Math.min(45, Math.max(25, 230 / width * 100)), max = Math.max(55, Math.min(75, 100 - 280 / width * 100));
    figureSplit = Math.max(min, Math.min(max, value));
    $('figure-split').style.gridTemplateColumns = `minmax(0,${figureSplit}fr) 12px minmax(0,${100-figureSplit}fr)`;
    for(const [name,v] of [['valuenow',figureSplit],['valuemin',min],['valuemax',max]]) $('figure-splitter').setAttribute('aria-'+name,String(Math.round(v)));
    $('figure-ratio').textContent = `左图 ${Math.round(figureSplit)}% / 右文 ${100-Math.round(figureSplit)}%`;
    if(persist) action('appearance', { appearance: { figureSplit } });
  }
  function setFigureFont(value, persist = false) {
    figureFontSize = Math.max(14, Math.min(24, value)); $('figure-viewer').style.setProperty('--figure-font', figureFontSize + 'px');
    if(persist) action('appearance', { appearance: { figureFontSize } });
  }
  function setFigureTab(tab) {
    tabPositions[figureTab] = $('figure-captions').scrollTop; figureTab = tab;
    for(const button of document.querySelectorAll('[data-figure-tab]')) {
      const on = button.dataset.figureTab === tab; button.setAttribute('aria-selected',String(on)); button.tabIndex=on?0:-1;
      $('figure-'+button.dataset.figureTab+'-panel').hidden=!on;
    }
    $('figure-captions').scrollTop=tabPositions[tab]||0;
    $('figure-chat-form').hidden=tab!=='chat';
    $('selection-tools').hidden=true; $('annotation-editor').hidden=true; window.getSelection()?.removeAllRanges();
  }
  function renderFigureContent(state) {
    const captionBlocks = (figure.captionIds || []).map(id=>state.reading.blocks.find(b=>b.id===id)).filter(Boolean);
    const ids = new Set([figure.id,...figure.captionIds||[]]);
    const rows = (state.annotations || []).filter(a=>(a.segments||[]).some(s=>ids.has(s.blockId)) || a.paragraphRefs?.some(id=>ids.has(id)));
    const stamp = JSON.stringify([figure.readingNote,captionBlocks,rows,state.layout?.revision]); if(stamp===figureNoteStamp)return;
    const savedSelection=capture(), top=$('figure-captions').scrollTop;
    figureNoteStamp=stamp; $('figure-note-content').replaceChildren(); $('figure-caption-panel').replaceChildren();
    if(figure.readingNote?.text){
      const note=ZNR.element('section',undefined,'figure-reading-note');
      note.append(ZNR.element('p',figure.readingNote.mode==='image'?'依据原图、图注与正文':'仅依据图注与正文，未查看实际图像','small muted'));
      ZNR.generated(note,figure,state.annotations||[]); $('figure-note-content').append(note);
    }else $('figure-note-content').append(ZNR.element('p','这张图尚未生成解读。可查看双语图注，或点击下方按钮开始解读。','muted'));
    $('figure-explain').hidden=!!figure.readingNote?.text;
    for(const caption of captionBlocks){
      const section=ZNR.element('section',undefined,'source-block figure-caption-text');section.dataset.id=caption.id;section.dataset.page=caption.page;
      for(const language of ['original','translation']){if(!caption[language])continue;section.append(ZNR.element('h3',language==='original'?'ENGLISH · 原文图注':'中文 · 已有译文'));const paragraph=ZNR.element('div',undefined,language);api.paintText(paragraph,caption,language);section.append(paragraph);}
      $('figure-caption-panel').append(section);
    }
    if(!captionBlocks.length)$('figure-caption-panel').append(ZNR.element('p','暂无对应图注。','muted'));
    $('figure-annotation-count').textContent=String(rows.length); $('figure-annotations-panel').replaceChildren();
    if(!rows.length)$('figure-annotations-panel').append(ZNR.element('p','在图解或图注中选中文字，即可高亮、批注并自动同步到 Obsidian。','muted'));
    for(const row of rows){
      const card=ZNR.element('article',undefined,'figure-annotation-card');
      const quote=(row.segments||[]).filter(s=>ids.has(s.blockId)).map(s=>s.text||state.reading.blocks.find(b=>b.id===s.blockId)?.[s.language]?.slice(s.start,s.end)||'').join('\n');
      if(quote)card.append(ZNR.element('blockquote',quote)); if(row.displayComment||row.comment)card.append(ZNR.element('p',row.displayComment||row.comment));
      const edit=ZNR.element('button','查看 / 编辑批注','text-button');edit.addEventListener('click',()=>editByKeys([row.key],edit.getBoundingClientRect()));card.append(edit);$('figure-annotations-panel').append(card);
    }
    $('figure-captions').scrollTop=top; if(savedSelection)restoreSelection(savedSelection);
  }
  function rememberFigureView() {
    ZNRFigureChat.remember();
    if(!figureViewKey)return;tabPositions[figureTab]=$('figure-captions').scrollTop;
    figureViews.set(figureViewKey,{tab:figureTab,positions:{...tabPositions},zoomMode,scale,top:$('figure-stage').scrollTop,left:$('figure-stage').scrollLeft});
  }
  async function openFigure(block, button) {
    const state = api.state(); if (!state.assets?.[block.asset]) return;
    if(figureViewKey)rememberFigureView();
    const token=++figureOpenToken;
    figure = block; figurePosition = api.position(); focusBefore = button || document.activeElement;
    figureViewKey=state.key+':'+block.id; const saved=figureViews.get(figureViewKey);
    ZNRFigureChat.open(block);
    figureNoteStamp=''; tabPositions={note:0,caption:0,chat:0,annotations:0};
    const title = (block.captionIds || []).map(id => state.reading.blocks.find(b => b.id === id)?.original || '').join(' ');
    const translated=(block.captionIds||[]).map(id=>state.reading.blocks.find(b=>b.id===id)?.translation||'').find(Boolean);
    $('figure-title').textContent = translated?.split('。')[0] || title.split(/\s+/).slice(0,12).join(' ') || '完整图表';
    $('figure-label').textContent = `${block.id} · 原文第 ${block.page} 页`; $('figure-paper').textContent=state.paper?.title||'';
    $('figure-captions').scrollTop=0; window.getSelection()?.removeAllRanges(); renderFigureContent(state);
    setFigureTab(saved?.tab || (block.readingNote?.text?'note':'caption')); tabPositions=saved?.positions||{note:0,caption:0,chat:0,annotations:0};
    $('figure-captions').scrollTop=tabPositions[figureTab];
    $('figure-save-status').textContent=state.error||state.annotationStatus||'选段与批注自动同步到 Obsidian'; $('figure-undo').hidden=!state.canUndo;
    const image = $('figure-image'); image.src = state.assets[block.asset]; image.alt = title || `完整图表 · 第 ${block.page} 页`;
    if(!$('figure-viewer').open)$('figure-viewer').showModal();
    setFigureSplit(state.appearance?.figureSplit||figureSplit);setFigureFont(state.appearance?.figureFontSize||figureFontSize);
    await image.decode().catch(() => {});
    if(token!==figureOpenToken||!$('figure-viewer').open)return;
    if(saved?.zoomMode==='manual')figureZoom(saved.scale);else fitFigure(saved?.zoomMode||'all');
    if(saved){$('figure-stage').scrollTop=saved.top;$('figure-stage').scrollLeft=saved.left;}
  }
  function askFigure(block, explain = false) {
    if (!block) return;
    if (explain && block.readingNote?.text) {
      if ($('figure-viewer').open && figure?.id===block.id) setFigureTab('note');
      else void openFigure(block);
      return;
    }
    const selection={kind:'figure',blockId:block.id,page:block.page,figureNote:explain,text:`已附图表 ${block.id} · 第 ${block.page} 页（完整原图与图注）`};
    const prompt=explain?'请生成这张图的 Nature 精读阅读提示：怎么看、说明什么，以及有哪些局限。':'';
    if($('figure-viewer').open&&figure?.id===block.id){ZNRFigureChat.ask(selection,prompt,explain);return;}
    action('selection', {selection,intent:explain?'explain':'ask',prompt});
  }
  function init(value) {
    api = value;
    ZNRFigureChat.init({state:()=>api.state(),action,tab:setFigureTab,active:()=>figureTab==='chat'});
    colors.forEach((value, index) => {
      const button = ZNR.element('button'); button.dataset.color = value; button.style.backgroundColor = value;
      button.setAttribute('aria-label', ['黄色', '红色', '绿色', '蓝色', '紫色', '洋红', '橙色', '灰色'][index]); button.addEventListener('click', () => selectColor(value)); $('annotation-colors').append(button);
    });
    document.addEventListener('pointerdown', event => { if (event.target.closest?.('#selection-tools')) event.preventDefault(); });
    function selectionChanged(event) {
      if (event?.target?.closest?.('#selection-tools,#annotation-editor,#figure-chat-form')) return;
      const next = capture(); if (!next) { $('selection-tools').hidden = true; return; }
      if (JSON.stringify(next) !== JSON.stringify(selected)) operationId = uid(); selected = next;
      for(const button of document.querySelectorAll('[data-selection]'))button.hidden=next.origin==='conversation'&&['highlight','comment','source'].includes(button.dataset.selection);
      const owner=$('figure-viewer').open ? $('figure-viewer') : document.body;
      for(const id of ['selection-tools','annotation-editor'])if($(id).parentElement!==owner)owner.append($(id));
      place($('selection-tools'), window.getSelection().getRangeAt(0).getBoundingClientRect());
    }
    document.addEventListener('mouseup', selectionChanged);
    document.addEventListener('keyup', event => { if (event.key === 'Shift' || event.key.startsWith('Arrow')) selectionChanged(event); });
    for (const button of document.querySelectorAll('[data-selection]')) button.addEventListener('click', () => {
      if (!selected) return; const type = button.dataset.selection;
      if (type === 'copy') { action('copy', { text: selected.text }); feedback('已复制选中文字'); }
      else if (type === 'ask' || type === 'explain') {
        const selection=selected;
        if($('figure-viewer').open){
          const prompt=type==='explain'?'请解释我选中的内容，结合本论文的上下文，并标注依据。':'';
          ZNRFigureChat.ask(selection,prompt,type==='explain');$('selection-tools').hidden=true;return;
        }
        action('selection', { selection, prompt: type === 'explain' ? '请解释我选中的内容，结合本论文的上下文，并标注依据。' : '', intent: type });
      }
      else if (type === 'source') { const first = selected.segments[0]; if($('figure-viewer').open)$('figure-viewer').close(); action('source', { blockId: first.blockId, selection:selected, start: first.language === 'original' ? first.start : 0, ...(first.language === 'original' ? { end: first.end } : {}) }); }
      else if (type === 'highlight' || type === 'comment') {
        $('annotation-choice').hidden = true; openEditor(null, $('selection-tools').getBoundingClientRect());
        if (type === 'comment') $('annotation-comment').focus();
      }
      $('selection-tools').hidden = true;
    });
    document.addEventListener('click', event => {
      if (window.getSelection()?.toString().trim()) return;
      const mark = event.target.closest?.('[data-annotation-keys]');
      if (mark) editByKeys(mark.dataset.annotationKeys.split(','), mark.getBoundingClientRect());
    });
    $('annotation-choice').addEventListener('change', event => { const row = api.state().annotations.find(a => a.key === event.target.value); if (row) openEditor(row); });
    $('annotation-close').addEventListener('click', () => { $('annotation-editor').hidden = true; });
    $('annotation-save').addEventListener('click', () => {
      const common = { color, comment: $('annotation-comment').value };
      if (editing) action('annotation-edit', { key: editing.key, ...common });
      else if (selected) action('annotation-create', { selection: selected, operationId: operationId ||= uid(), ...common });
      $('annotation-editor').hidden = true; window.getSelection()?.removeAllRanges(); feedback('正在保存标注…');
    });
    $('annotation-remove').addEventListener('click', () => { if (editing) action('annotation-edit', { key: editing.key, remove: true }); $('annotation-editor').hidden = true; feedback('正在删除标注…'); });
    $('annotation-source').addEventListener('click', () => { if (editing) { if($('figure-viewer').open)$('figure-viewer').close(); action('source', { annotationKey: editing.key, page: editing.page }); } });
    $('undo-annotation').addEventListener('click', () => action('annotation-undo'));
    $('retry-layout').addEventListener('click', () => action('retry-layout'));
    $('dismiss-feedback').addEventListener('click', () => { $('reader-feedback').hidden = true; notice = ''; });
    $('figure-plus').addEventListener('click', () => figureZoom(scale * 1.25)); $('figure-minus').addEventListener('click', () => figureZoom(scale / 1.25)); $('figure-fit').addEventListener('click', () => fitFigure());
    $('figure-fit-width').addEventListener('click',()=>fitFigure('width'));
    $('figure-font-minus').addEventListener('click',()=>setFigureFont(figureFontSize-1,true)); $('figure-font-plus').addEventListener('click',()=>setFigureFont(figureFontSize+1,true));
    $('figure-undo').addEventListener('click',()=>action('annotation-undo'));
    for(const button of document.querySelectorAll('[data-figure-tab]')){
      button.addEventListener('click',()=>setFigureTab(button.dataset.figureTab));
      button.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=['note','caption','chat','annotations'],next=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1):tabs[(tabs.indexOf(figureTab)+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];setFigureTab(next);$('figure-tab-'+next).focus();});
    }
    const splitter=$('figure-splitter');let splitting=false;
    splitter.addEventListener('pointerdown',e=>{if(e.button!==0)return;splitting=true;splitter.setPointerCapture(e.pointerId);$('figure-viewer').classList.add('resizing');$('selection-tools').hidden=true;e.preventDefault();});
    splitter.addEventListener('pointermove',e=>{if(splitting)setFigureSplit((e.clientX-$('figure-split').getBoundingClientRect().left)/($('figure-split').clientWidth-12)*100);});
    const finishSplit=()=>{if(!splitting)return;splitting=false;$('figure-viewer').classList.remove('resizing');setFigureSplit(figureSplit,true);};
    splitter.addEventListener('pointerup',finishSplit);splitter.addEventListener('pointercancel',finishSplit);splitter.addEventListener('lostpointercapture',finishSplit);
    splitter.addEventListener('dblclick',()=>setFigureSplit(50,true));
    splitter.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();setFigureSplit(e.key==='Home'?25:e.key==='End'?75:figureSplit+(e.key==='ArrowLeft'?-2:2),true);});
    $('figure-captions').addEventListener('scroll',()=>{
      const selection=window.getSelection(), viewport=$('figure-captions').getBoundingClientRect();
      const rect=selection?.rangeCount&&!selection.isCollapsed?selection.getRangeAt(0).getBoundingClientRect():null;
      if(rect&&rect.bottom>viewport.top&&rect.top<viewport.bottom&&$('annotation-editor').hidden)selectionChanged();
      else $('selection-tools').hidden=true;
    });
    $('figure-close').addEventListener('click', () => $('figure-viewer').close());
    $('figure-ask').addEventListener('click', () => askFigure(figure));
    $('figure-explain').addEventListener('click', () => askFigure(figure, true));
    $('figure-source').addEventListener('click', () => { if (figure) { $('figure-viewer').close(); action('source', { blockId: figure.id, page: figure.page }); } });
    $('figure-viewer').addEventListener('close', () => {
      // A queued close event can arrive after another figure has already opened.
      // It must not overwrite the new view or cancel its image fitting.
      if($('figure-viewer').open)return;
      rememberFigureView(); figureOpenToken++;
      for(const id of ['selection-tools','annotation-editor']){document.body.append($(id));$(id).hidden=true;}
      if (figurePosition) api.restore(figurePosition); focusBefore?.focus({ preventScroll: true });
    });
    const stage = $('figure-stage'); let drag = null;
    stage.addEventListener('pointerdown', event => { if (event.button !== 0) return; drag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop }; stage.setPointerCapture(event.pointerId); event.preventDefault(); });
    stage.addEventListener('pointermove', event => { if (drag) { stage.scrollLeft = drag.left - event.clientX + drag.x; stage.scrollTop = drag.top - event.clientY + drag.y; } });
    stage.addEventListener('pointerup', () => { drag = null; }); stage.addEventListener('pointercancel', () => { drag = null; });
    stage.addEventListener('dblclick', () => fitFigure());
    new ResizeObserver(()=>{if($('figure-viewer').open&&zoomMode!=='manual')fitFigure(zoomMode);}).observe(stage);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('selection-tools').hidden = true; $('annotation-editor').hidden = true; } });
    window.addEventListener('resize', () => { $('selection-tools').hidden = true; if ($('figure-viewer').open) setFigureSplit(figureSplit); });
  }
  return { init, capture, restoreSelection, update, reset, openFigure, askFigure, feedback };
})();
