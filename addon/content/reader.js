'use strict';
const $ = id => document.getElementById(id);
let state = {}, signature = '', readingId = '', expandedGroups = new Set(), lastNavigation = '', positionTimer;
let appearance = { fontSize: 20, fontFamily: 'source', chineseFont: 'sans', paperWidth: 1280, fitWidth: true, outlineOpen: false, theme: 'system', showHighlights: true };
const nodes = new Map(), groups = new Map(), loadedFonts = new Map();
function position() {
  const article = [...document.querySelectorAll('.reading-anchor')].find(node => !node.closest('details:not([open])') && node.getClientRects().length && node.getBoundingClientRect().bottom > 90);
  return { scrollTop: document.scrollingElement.scrollTop, blockId: article?.dataset.id || '', offset: article ? article.getBoundingClientRect().top - 60 : 0, anchorHeight: article?.getBoundingClientRect().height || 0, anchorVersion: 3, expandedGroups: [...expandedGroups] };
}
function reveal(article) { for (let parent = article?.parentElement; parent; parent = parent.parentElement) if (parent.localName === 'details') parent.open = true; }
function restorePosition(saved) {
  if (!saved) return;
  let article = saved.blockId && document.getElementById('source-' + saved.blockId);
  if (article?.dataset.visualParentId) article = document.getElementById('source-' + article.dataset.visualParentId);
  reveal(article);
  let offset = saved.anchorVersion >= 2 ? saved.offset || 0 : 0;
  if (article && saved.anchorVersion === 3 && offset < 0 && saved.anchorHeight > 0) offset *= article.getBoundingClientRect().height / saved.anchorHeight;
  document.scrollingElement.scrollTop = article ? document.scrollingElement.scrollTop + article.getBoundingClientRect().top - 60 - offset : saved.scrollTop || 0;
}
function locate(id) {
  let node = document.getElementById('source-' + id);
  if (node?.dataset.visualParentId) node = document.getElementById('source-' + node.dataset.visualParentId);
  if (!node) return;
  reveal(node); node.scrollIntoView({ block: 'center', behavior: 'auto' }); node.classList.remove('located'); void node.offsetWidth; node.classList.add('located');
  window.setTimeout(() => node.classList.remove('located'), 2200); queuePosition();
}
function applyAppearance(next) {
  appearance = { ...appearance, ...next };
  document.documentElement.style.setProperty('--reader-font', appearance.fontSize + 'px');
  document.documentElement.style.setProperty('--paper-width', appearance.fitWidth ? '100%' : appearance.paperWidth + 'px');
  document.body.dataset.font = appearance.fontFamily; document.body.dataset.chineseFont = appearance.chineseFont;
  document.body.dataset.highlights = String(appearance.showHighlights); ZNR.theme(appearance.theme);
  $('reader-font-family').value = appearance.fontFamily; $('reader-chinese-font').value = appearance.chineseFont; $('reader-theme').value = appearance.theme;
  $('reader-font-size').value = appearance.fontSize; $('font-size-value').textContent = appearance.fontSize + ' px';
  $('reader-width').value = appearance.paperWidth; $('width-value').textContent = appearance.fitWidth ? '适应窗口' : appearance.paperWidth + ' px';
  $('fit-width').setAttribute('aria-pressed', String(appearance.fitWidth)); $('toggle-highlights').setAttribute('aria-pressed', String(appearance.showHighlights));
  $('outline-panel').hidden = !appearance.outlineOpen; $('toggle-outline').setAttribute('aria-expanded', String(appearance.outlineOpen));
}
function changeAppearance(patch) { const saved = position(); applyAppearance(patch); restorePosition(saved); ZNR.action('appearance', { appearance: patch }); }
function reconcile(parent, desired) {
  for (let i = 0; i < desired.length; i++) if (parent.children[i] !== desired[i]) parent.insertBefore(desired[i], parent.children[i] || null);
  const keep = new Set(desired); for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
}
function sourceButton(block, compact = false) {
  const button = ZNR.element('button', compact ? `p.${block.page}` : `${block.id} · 原文第 ${block.page} 页`, 'source-button');
  button.title = `${block.id} · 定位原文第 ${block.page} 页`; button.setAttribute('aria-label', button.title);
  button.addEventListener('click', () => ZNR.action('source', { blockId: block.id, page: block.page })); return button;
}
function categoryTone(category) { return /方法/.test(category) ? 'amber' : /结果/.test(category) ? 'blue' : /局限|不足/.test(category) ? 'rose' : /结论/.test(category) ? 'violet' : 'green'; }
function paintText(node, block, language, sourceOffset = 0) {
  const text = block[language], layout = state.layout?.blocks?.[block.id];
  const runs = language === 'original' ? layout?.runs || [] : [];
  const annotations = (state.annotations || []).flatMap(a => (a.segments || []).filter(s => s.blockId === block.id && s.language === language).map(s => ({ ...s, key: a.key, color: a.color })));
  const highlights = (state.reading.guide?.highlights || []).filter(h => h.blockId === block.id).flatMap(h => {
    const quote = h[language]; if (!quote || text.indexOf(quote) < 0) return [];
    const start = text.indexOf(quote); return [{ start, end: start + quote.length, tone: categoryTone(h.category) }];
  });
  const boundaries = [...new Set([sourceOffset, text.length, ...[...runs, ...annotations, ...highlights].flatMap(r => [r.start, r.end])])].filter(n => Number.isInteger(n) && n >= sourceOffset && n <= text.length).sort((a, b) => a - b);
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1]; if (end <= start) continue;
    const run = runs.find(r => r.start <= start && r.end >= end), marked = annotations.filter(r => r.start < end && r.end > start), emphasis = highlights.find(r => r.start < end && r.end > start);
    const span = ZNR.element('span', text.slice(start, end));
    if (run) {
      if (run.bold) span.style.fontWeight = '700'; if (run.italic) span.style.fontStyle = 'italic';
      if (run.script === 'super' || run.script === 'sub') { span.classList.add('script-' + run.script); }
      else if (run.size && layout.baseSize && Math.abs(run.size / layout.baseSize - 1) > .12) span.style.fontSize = Math.max(.72, Math.min(1.5, run.size / layout.baseSize)) + 'em';
      if (run.fontId && /^[a-zA-Z0-9_-]+$/.test(run.fontId)) { span.classList.add('pdf-run'); span.style.setProperty('--source-face', `var(--pdf-${run.fontId}, var(--serif))`); }
    }
    if (emphasis) { span.classList.add('reading-emphasis'); span.dataset.tone = emphasis.tone; }
    if (marked.length) { span.classList.add('user-highlight'); span.dataset.annotationKeys = marked.map(a => a.key).join(','); span.style.setProperty('--mark-color', marked[0].color); span.title = '点击编辑高亮与批注'; }
    node.append(span);
  }
}
function blockArticle(block, isTitle = false, compact = false) {
  const annotations = (state.annotations || []).filter(a => a.segments.some(s => s.blockId === block.id) || a.paragraphRefs?.includes(block.id));
  const stamp = JSON.stringify([block, state.layout?.revision, state.reading.guide?.highlights?.filter(h => h.blockId === block.id), annotations, !!state.assets?.[block.asset], isTitle, compact]);
  const cached = nodes.get(block.id); if (cached?.stamp === stamp) return cached.node;
  const article = ZNR.element('article', undefined, 'source-block reading-anchor ' + block.type + (isTitle ? ' paper-title-block' : '') + (compact ? ' compact-fragment' : ''));
  article.id = 'source-' + block.id; article.dataset.id = block.id; article.dataset.page = block.page;
  const meta = ZNR.element('div', undefined, 'block-meta'); meta.append(sourceButton(block, !compact)); article.append(meta);
  if (block.original) { const original = ZNR.element(isTitle ? 'h1' : block.type === 'heading' ? 'h2' : 'div', undefined, 'original'); paintText(original, block, 'original'); article.append(original); }
  if (block.asset) {
    const actions = ZNR.element('div', undefined, 'figure-actions');
    const ask = ZNR.element('button', '问这张图', 'text-button'), explain = ZNR.element('button', '图表与解读', 'text-button');
    ask.addEventListener('click', () => ZNRTools.askFigure(block)); explain.addEventListener('click', () => ZNRTools.openFigure(block, explain));
    actions.append(ask, explain); article.append(actions);
    if (state.assets?.[block.asset]) {
      const image = ZNR.element('img'); image.src = state.assets[block.asset]; image.alt = `原文第 ${block.page} 页完整图表`; image.loading = 'lazy'; image.draggable = false;
      if (block.bbox) image.style.aspectRatio = (block.bbox[2] - block.bbox[0]) + ' / ' + (block.bbox[3] - block.bbox[1]);
      image.tabIndex = 0; image.setAttribute('role', 'button'); image.title = '点击放大查看完整图表';
      image.addEventListener('click', () => ZNRTools.openFigure(block, image)); image.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ZNRTools.openFigure(block, image); } }); article.append(image);
    } else article.append(ZNR.element('div', '图片暂不可用，请回到原文查看。', 'pending-translation'));
  }
  if (block.translation) { const translation = ZNR.element('div', undefined, 'translation'); paintText(translation, block, 'translation'); article.append(translation); }
  else if (block.original && block.status !== 'complete') article.append(ZNR.element('div', '等待本段译文…', 'pending-translation'));
  for (const annotation of annotations.filter(a => a.paragraphRefs?.includes(block.id) && !a.segments.some(s => s.blockId === block.id && s.language === 'translation'))) {
    const badge = ZNR.element('button', '本段有原文标注', 'paragraph-annotation'); badge.dataset.annotationKeys = annotation.key; article.append(badge);
  }
  nodes.set(block.id, { stamp, node: article }); return article;
}
function continuationArticle(blocks) {
  const key='continuation:'+blocks[0].id, ids=new Set(blocks.map(b=>b.id));
  const annotations=(state.annotations||[]).filter(a=>(a.segments||[]).some(s=>ids.has(s.blockId))||a.paragraphRefs?.some(id=>ids.has(id)));
  const stamp=JSON.stringify([blocks,state.layout?.revision,annotations,state.reading.guide?.highlights]);
  const cached=nodes.get(key);if(cached?.stamp===stamp)return cached.node;
  const article=ZNR.element('article',undefined,'source-block reading-anchor continuation-paragraph');article.id='source-'+blocks[0].id;article.dataset.id=blocks[0].id;article.dataset.page=blocks[0].page;
  const meta=ZNR.element('div',undefined,'block-meta');for(const block of blocks)meta.append(sourceButton(block,true));article.append(meta);
  for(const language of ['original','translation']){
    const paragraph=ZNR.element('div',undefined,'continuation-'+language);let previous='';
    for(const [index,block] of blocks.entries()){
      const text=block[language]||'';let offset=0;
      if(language==='translation'&&previous){
        // Collapse only exact Han-word overlap introduced by separately translated fragments.
        // Keep canonical strings and source offsets for native annotation mapping.
        for(let n=Math.min(12,previous.length,text.length);n>=2;n--)if(/^[\u3400-\u9fff]+$/.test(text.slice(0,n))&&previous.endsWith(text.slice(0,n))){offset=n;break;}
        if(annotations.some(a=>(a.segments||[]).some(s=>s.blockId===block.id&&s.language===language&&s.start<offset)))offset=0;
      }
      if(index)paragraph.append(document.createTextNode(language==='original'?(/[-\u2010]$/.test(previous)?'':' '):(/[\u3400-\u9fff]$/.test(previous)&&/^[\u3400-\u9fff]/.test(text.slice(offset))?'':' ')));
      const part=ZNR.element('span',undefined,'source-part '+language);part.dataset.sourceId=block.id;part.dataset.page=block.page;part.dataset.language=language;part.dataset.sourceOffset=String(offset);
      if(language==='original'&&index){part.id='source-'+block.id;part.dataset.id=block.id;}
      if(offset)part.title=`衔接处已省略重复的“${text.slice(0,offset)}”；原译文与来源位置保留。`;
      paintText(part,block,language,offset);paragraph.append(part);previous=text;
    }
    article.append(paragraph);
  }
  const sources=ZNR.element('div',undefined,'continuation-sources');sources.append(ZNR.element('span','跨栏 / 跨页续段','muted small'));
  for(const block of blocks)sources.append(sourceButton(block));article.append(sources);
  for(const annotation of annotations.filter(a=>a.paragraphRefs?.some(id=>ids.has(id))&&!(a.segments||[]).some(s=>ids.has(s.blockId)))){
    const badge=ZNR.element('button','本段有原文标注','paragraph-annotation');badge.dataset.annotationKeys=annotation.key;article.append(badge);
  }
  nodes.set(key,{stamp,node:article});return article;
}
function fragmentGroup(key, blocks, graphic) {
  let group = groups.get(key);
  const authors = key.startsWith('authors-');
  if (!group) {
    group = ZNR.element('details', undefined, 'fragment-group' + (authors ? ' author-details' : '')); group.dataset.group = key; group.open = expandedGroups.has(key);
    const summary = ZNR.element('summary'); summary.append(ZNR.element('span', authors ? '作者、单位与通讯信息' : graphic ? '图表文字与译文' : `第 ${blocks[0].page} 页附注`), ZNR.element('span', authors ? [state.paper?.journal, state.paper?.year].filter(Boolean).join(' · ') : `${blocks.length} 条 · 点击展开`, 'muted small'));
    group.append(summary, ZNR.element('div', undefined, 'fragment-list')); groups.set(key, group);
    group.addEventListener('toggle', () => { if (group.open) expandedGroups.add(key); else expandedGroups.delete(key); queuePosition(); });
  }
  reconcile(group.lastElementChild, blocks.map(block => blockArticle(block, false, true))); return group;
}
async function installFonts(next) {
  for (const font of next.layout?.fonts || []) {
    if (!next.fonts?.[font.id] || loadedFonts.has(font.id) || !/^[a-zA-Z0-9_-]+$/.test(font.id)) continue;
    const saved = position(), before = document.scrollingElement.scrollTop, paperKey = next.key;
    const face = new FontFace(font.family, `url(${next.fonts[font.id]})`, { display: 'swap' }); loadedFonts.set(font.id, face);
    try { await face.load(); document.fonts.add(face); document.documentElement.style.setProperty('--pdf-' + font.id, '"' + font.family.replaceAll('"', '') + '"'); if (state.key === paperKey && Math.abs(document.scrollingElement.scrollTop - before) < 3) restorePosition(saved); }
    catch { loadedFonts.delete(font.id); }
  }
  const fonts = next.layout?.fonts || []; $('font-status').textContent = fonts.length ? `原文 ${fonts.filter(f => f.available).length} / ${fonts.length} 种字体可用；其余自动使用学术字体。` : '原文字体准备中，当前使用本地学术字体。';
}
function render(next) {
  const changedPaper = state.key !== next.key || readingId !== next.reading?.id;
  const savedPosition = !changedPaper && signature ? position() : next.position;
  const savedSelection = !changedPaper ? ZNRTools.capture() : null;
  state = next; applyAppearance(next.appearance || {});
  if (changedPaper) { nodes.clear(); groups.clear(); expandedGroups = new Set(next.position?.expandedGroups || []); ZNRTools.reset(); signature = ''; }
  ZNRTools.update(next);
  const reading = next.reading; readingId = reading?.id || '';
  $('toggle-sidebar').setAttribute('aria-pressed', String(!next.sidebarCollapsed));
  if (!reading) {
    $('reading-body').replaceChildren(); $('outline').replaceChildren(); $('figure-outline').replaceChildren();
    const empty = ZNR.element('div', undefined, 'reader-empty'); empty.append(ZNR.element('span', 'N', 'empty-symbol'), ZNR.element('h1', '读懂原文，逐段深入'), ZNR.element('p', '点击阅读助手中的“开始精读”，已完成段落与讨论将自动保存到 Obsidian。')); $('reading-body').append(empty); $('reading-status').textContent = ''; return;
  }
  $('reading-status').textContent = reading.status === 'complete' ? '全文已完成' : `${reading.doneBlocks || 0} / ${reading.totalBlocks || 0} 段`;
  const stamp = JSON.stringify([reading.id, reading.revision, next.layout?.revision, next.layout?.status, next.annotations || [], Object.keys(next.assets || {})]);
  if (stamp !== signature) {
    signature = stamp;
    const plan = ZNRLayout.layoutReading(reading.blocks, state.paper?.title || reading.title, state.paper?.authors, next.layout);
    const byId = new Map(reading.blocks.map(block => [block.id, block])), captionOwners = new Map();
    for (const block of reading.blocks) if (block.asset) for (const id of block.captionIds || []) if (byId.get(id)?.type === 'caption') captionOwners.set(id, block.id);
    const desired = [], toc = [], figures = [], lastOnPage = new Map(); for (const block of reading.blocks) lastOnPage.set(block.page, block.id);
    if (!plan.titleId) desired.push(ZNR.element('h1', state.paper?.title || reading.title, 'reading-title'));
    const addMetadata = () => { if (plan.metadataKey) desired.push(fragmentGroup(plan.metadataKey, plan.groups.get(plan.metadataKey), false)); };
    if (!plan.titleId) addMetadata();
    for (const block of reading.blocks) {
      if(plan.continuationOwners.has(block.id)&&plan.continuationOwners.get(block.id)!==block.id)continue;
      if (!plan.owners.has(block.id) && !captionOwners.has(block.id) && !block.visualParentId) {
        const article = plan.continuations.has(block.id) ? continuationArticle(plan.continuations.get(block.id)) : blockArticle(block, plan.titleId === block.id);
        desired.push(article);
        if (block.id === plan.titleId) addMetadata();
        for (const id of block.captionIds || []) if (byId.get(id)?.type === 'caption') {
          const caption = blockArticle(byId.get(id));
          for (const previous of [...article.children]) if (previous.id === caption.id && previous !== caption) previous.remove();
          if (caption.parentElement !== article) article.append(caption);
        }
        const graphics = plan.groups.get('graphic-' + block.id); if (graphics) desired.push(fragmentGroup('graphic-' + block.id, graphics, true));
        if (block.type === 'heading' && block.id !== plan.titleId) { const link = ZNR.element('button', block.translation || block.original); link.addEventListener('click', () => { locate(block.id); changeAppearance({ outlineOpen: false }); }); toc.push(link); }
        if (block.asset) {
          const link = ZNR.element('button', undefined, 'figure-nav-item'), image = ZNR.element('img'); image.src = state.assets?.[block.asset] || ''; image.alt = ''; image.loading = 'lazy';
          const caption = byId.get(block.captionIds?.[0]); link.append(image, ZNR.element('span', caption?.translation || caption?.original || `第 ${block.page} 页图表`)); link.addEventListener('click', () => { locate(block.id); changeAppearance({ outlineOpen: false }); }); figures.push(link);
        }
      }
      if (lastOnPage.get(block.page) === block.id && plan.groups.has('notes-' + block.page)) desired.push(fragmentGroup('notes-' + block.page, plan.groups.get('notes-' + block.page), false));
    }
    reconcile($('reading-body'), desired);
    for (const block of reading.blocks) if (block.visualParentId && !document.getElementById('source-' + block.id)) {
      const anchor = ZNR.element('span', undefined, 'source-alias'); anchor.id = 'source-' + block.id; anchor.dataset.visualParentId = block.visualParentId; document.getElementById('source-' + block.visualParentId)?.prepend(anchor);
    }
    if (!toc.length) for (const page of [...new Set(reading.blocks.map(b => b.page))]) { const block = reading.blocks.find(b => b.page === page), link = ZNR.element('button', `第 ${page} 页`); link.addEventListener('click', () => locate(block.id)); toc.push(link); }
    $('outline').replaceChildren(...toc); $('figure-outline').replaceChildren(...figures);
    restorePosition(savedPosition); ZNRTools.restoreSelection(savedSelection); installFonts(next);
  }
  if (next.navigation?.id && next.navigation.id !== lastNavigation) {
    lastNavigation = next.navigation.id;
    const figure=next.navigation.openFigure&&reading.blocks.find(b=>b.id===next.navigation.blockId&&b.asset);
    if(figure)ZNRTools.openFigure(figure);else locate(next.navigation.blockId);
  }
}
ZNRTools.init({ state: () => state, position, restore: restorePosition, paintText });
let layoutAnchor;
document.addEventListener('znr-before-layout', () => { if (state.reading && !layoutAnchor) layoutAnchor = position(); });
document.addEventListener('znr-after-layout', () => { if (layoutAnchor) { restorePosition(layoutAnchor); layoutAnchor = null; queuePosition(); } });
document.addEventListener('znr-state', event => { try { render(JSON.parse(event.detail)); } catch (error) { ZNRTools.feedback('阅读界面：' + error.message); console.error(error); } });
$('original').addEventListener('click', () => ZNR.action('mode', { mode: 'pdf' }));
$('toggle-sidebar').addEventListener('click', () => ZNR.action('toggle-sidebar'));
$('toggle-outline').addEventListener('click', () => changeAppearance({ outlineOpen: !appearance.outlineOpen })); $('close-outline').addEventListener('click', () => changeAppearance({ outlineOpen: false }));
$('toggle-highlights').addEventListener('click', () => changeAppearance({ showHighlights: !appearance.showHighlights }));
for (const [id, field] of [['reader-font-family', 'fontFamily'], ['reader-chinese-font', 'chineseFont'], ['reader-theme', 'theme']]) $(id).addEventListener('change', event => changeAppearance({ [field]: event.target.value }));
$('reader-font-size').addEventListener('input', event => changeAppearance({ fontSize: Number(event.target.value) })); $('reader-width').addEventListener('input', event => changeAppearance({ paperWidth: Number(event.target.value), fitWidth: false }));
$('fit-width').addEventListener('click', () => changeAppearance({ fitWidth: true })); $('comfort-width').addEventListener('click', () => changeAppearance({ fitWidth: false, paperWidth: 1120 }));
for (const [id, isFigures] of [['outline-sections', false], ['outline-figures', true]]) $(id).addEventListener('click', () => { $('outline').hidden = isFigures; $('figure-outline').hidden = !isFigures; $('outline-sections').classList.toggle('active', !isFigures); $('outline-figures').classList.toggle('active', isFigures); });
document.addEventListener('click', event => { if (!event.target.closest?.('#appearance-menu')) $('appearance-menu').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('appearance-menu').open = false; if (appearance.outlineOpen) changeAppearance({ outlineOpen: false }); } });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => ZNR.theme(appearance.theme));
function queuePosition() { window.clearTimeout(positionTimer); positionTimer = window.setTimeout(() => ZNR.action('position', { position: position() }), 500); }
document.addEventListener('scroll', queuePosition, { passive: true });
document.addEventListener('DOMContentLoaded', () => ZNR.action('ready'));
