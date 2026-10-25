'use strict';
const $ = id => document.getElementById(id);
let state = {}, sending = false, lastChat = '', lastGuide = '', activeTab = 'chat';
const paperUI = new Map(); let lastKey = '', lastCommand = '';
function selectTab(tab) {
  activeTab = tab;
  for (const button of document.querySelectorAll('[data-tab]')) button.classList.toggle('active', button.dataset.tab === tab);
  for (const name of ['chat', 'highlights', 'guide']) $(name + '-tab').hidden = name !== tab;
}
function renderChat(records) {
  const signature = JSON.stringify(records);
  if (signature === lastChat) return;
  lastChat = signature;
  if (!records.length) {
    const welcome = ZNR.element('div', undefined, 'welcome'); welcome.append(ZNR.element('h2', '从一个问题开始'), ZNR.element('p', '选中论文里的文字，或者直接输入问题。讨论会自动保存到这篇文献的 Obsidian 笔记。'));
    const quick = ZNR.element('div', undefined, 'quick-actions');
    for (const [label, prompt] of [['总结论文', '请概括这篇文献的核心问题、主要结论和证据，并标注来源。'], ['方法与局限', '请分析本论文的方法、证据强度与主要局限，并标注来源。']]) { const button = ZNR.element('button', label); button.addEventListener('click', () => { $('question').value = prompt; $('question').focus(); }); quick.append(button); }
    welcome.append(quick); $('messages').replaceChildren(welcome); return;
  }
  const scroller = $('tab-body'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  const messages = $('messages'); messages.replaceChildren();
  for (const record of records) {
    const user = ZNR.element('article', undefined, 'message user');
    const question=ZNR.element('div', record.question, 'message-body');question.dataset.recordId=record.id;question.dataset.recordRole='user';
    user.append(ZNR.element('div', '我', 'role'), question); messages.append(user);
    const answer = ZNR.element('article', undefined, 'message assistant'); answer.append(ZNR.element('div', 'NATURE · DSH', 'role'));
    const body = ZNR.element('div', undefined, 'message-body'); ZNR.markdown(body, record.answer || (record.status === 'pending' ? '正在准备原文材料…' : '')); answer.append(body);
    if(record.answer){body.dataset.recordId=record.id;body.dataset.recordRole='assistant';}
    const names = { pending: '已保存问题，正在准备', streaming: '正在回答 · 自动保存中', complete: '已保存至文献笔记', interrupted: '已停止 · 已生成内容保留', error: '生成遇到问题' };
    answer.append(ZNR.element('div', record.error || names[record.status] || '', 'message-state'));
    if (['interrupted', 'error'].includes(record.status)) {
      const retry = ZNR.element('button', '重试回答', 'text-button');
      retry.addEventListener('click', () => { sending = true; ZNR.action('chat', { id: record.id, question: record.question, retry: true }); }); answer.append(retry);
    }
    messages.append(answer);
  }
  if (nearBottom || records.length === 1) scroller.scrollTop = scroller.scrollHeight;
}
function renderGuide(guide, figureNotes = []) {
  const signature = JSON.stringify([guide, figureNotes]);
  if (signature === lastGuide) return;
  lastGuide = signature; $('highlights').replaceChildren(); $('guide').replaceChildren();
  if (!guide) {
    $('highlights').append(ZNR.element('p', '开始精读后，这里会按研究目标、方法、结果与局限展示有原文依据的阅读重点。', 'status-empty'));
    $('guide').append(ZNR.element('p', '精读指南会在全文处理后生成。你也可以先在问答中请求学习建议。', 'status-empty')); return;
  }
  const categories = [...new Set((guide.highlights || []).map(item => item.category))];
  for (const category of categories) {
    const group = ZNR.element('details', undefined, 'highlight-group'); group.open = true;
    group.dataset.tone = /方法/.test(category) ? 'amber' : /结果/.test(category) ? 'blue' : /局限|不足/.test(category) ? 'rose' : /结论/.test(category) ? 'violet' : 'green';
    const heading = ZNR.element('summary', undefined, 'category-heading');
    heading.append(ZNR.element('span', category), ZNR.element('span', String(guide.highlights.filter(item => item.category === category).length), 'category-count'));
    group.append(heading); $('highlights').append(group);
    for (const item of guide.highlights.filter(item => item.category === category)) {
      const card = ZNR.element('details', undefined, 'highlight-card');
      const preview = ZNR.element('summary');
      preview.append(ZNR.element('div', item.original, 'original'), ZNR.element('div', item.translation, 'translation'), ZNR.element('span', '展开解读', 'expand-hint')); card.append(preview);
      if (item.explanation) card.append(ZNR.element('div', item.explanation, 'explanation'));
      const actions = ZNR.element('div', undefined, 'highlight-actions');
      const locate = ZNR.element('button', '定位正文', 'source text-button'), source = ZNR.element('button', '查看原 PDF', 'source text-button');
      locate.addEventListener('click', () => ZNR.action('locate', { blockId: item.blockId })); source.addEventListener('click', () => ZNR.action('source', { blockId: item.blockId })); actions.append(locate, source); card.append(actions);
      group.append(card);
    }
  }
  $('guide').append(ZNR.element('h2', '这篇文献怎样读'));
  ZNR.markdown($('guide'), guide.overview);
  if (guide.readingOrder?.length) {
    $('guide').append(ZNR.element('h3', '建议阅读顺序')); const list = ZNR.element('ol');
    for (const text of guide.readingOrder) { const row = ZNR.element('li'); ZNR.inline(row, text); list.append(row); } $('guide').append(list);
  }
  if (guide.glossary?.length) {
    $('guide').append(ZNR.element('h3', '术语对照'));
    for (const entry of guide.glossary) { const row = ZNR.element('div', undefined, 'glossary-row'); row.append(ZNR.element('strong', entry.term), document.createTextNode(' · ' + entry.translation)); if (entry.note) row.append(ZNR.element('small', entry.note)); $('guide').append(row); }
  }
  if (figureNotes.length) {
    $('guide').append(ZNR.element('h3', '图表精读'));
    for (const figure of figureNotes) {
      const row = ZNR.element('div', undefined, 'category-group');
      const link = ZNR.element('button', `${figure.blockId} · 第 ${figure.page} 页 · ${figure.note?.text ? '图表与解读' : '打开图表'}`, 'source text-button');
      link.addEventListener('click', () => ZNR.action('locate', { blockId: figure.blockId, openFigure: true })); row.append(link); $('guide').append(row);
    }
  }
}
function render(next) {
  const key = next.key || '';
  if (key !== lastKey) {
    ZNRPanelSelection.reset();
    if (lastKey) paperUI.set(lastKey, { draft: $('question').value, tab: activeTab, scroll: $('tab-body').scrollTop });
    const saved = paperUI.get(key); $('question').value = saved?.draft || ''; selectTab(saved?.tab || 'chat');
    $('tab-body').scrollTop = saved?.scroll || 0; lastChat = ''; lastGuide = ''; lastCommand = ''; lastKey = key;
  }
  state = next; sending = false;
  ZNR.theme(next.appearance?.theme || 'system');
  $('paper-title').textContent = next.paper?.title || '请打开一篇 PDF 文献';
  $('compact-title').textContent = next.paper?.title || '请打开一篇 PDF 文献';
  $('compact-title').title = next.paper?.title || '';
  $('paper-overview').open = !!next.appearance?.overviewExpanded;
  $('connection').textContent = next.connected ? 'Harness 已连接' : '等待 Harness'; $('connection-dot').classList.toggle('connected', !!next.connected);
  $('error').hidden = !next.error; $('error').textContent = next.error || '';
  $('source-notice').hidden = !next.notice; $('source-notice').textContent = next.notice || '';
  $('archive-error').hidden = !next.archiveError; $('archive-error').textContent = next.archiveError ? '已保存在本地待归档：' + next.archiveError : '';
  $('archive-status').textContent = next.archiveError ? '待同步 · 记录已在本地保留' : next.annotationStatus || '内容自动保存到 Obsidian';
  $('mode-pdf').classList.toggle('active', next.mode === 'pdf'); $('mode-bilingual').classList.toggle('active', next.mode === 'bilingual');
  const reading = next.reading, done = reading?.doneBlocks || 0, total = reading?.totalBlocks || 0;
  const missingFigures = reading?.figureNotes?.filter(f => !f.note?.text).length || 0;
  $('compact-status').textContent = next.busyReading ? `精读中 · ${done} / ${total} 段` : reading?.status === 'complete' ? '精读已完成 · 展开操作' : next.connected ? '展开文献信息与精读操作' : '等待 Harness · 展开设置';
  $('generate').textContent = next.busyReading ? '正在精读…' : reading?.status === 'complete' ? missingFigures ? `补全 ${missingFigures} 张图表解读` : '精读已完成' : reading ? '继续精读' : '开始精读';
  $('generate').disabled = !next.connected || !!next.busyReading || reading?.status === 'complete' && !missingFigures;
  $('cancel-reading').hidden = !next.busyReading; $('progress').value = total ? done / total * 100 : 0;
  $('progress-label').textContent = total ? `${done} / ${total} 段` : reading?.status === 'extracting' ? '正在解析原文' : '全文双语 · 阅读指南';
  $('generation-note').textContent = reading?.error || (next.busyReading ? (total && done === total ? reading?.guide ? '正文和指南已保留，正在补充图表解读…' : '正文已保存，正在生成精读指南…' : '已完成段落持续保存到 Obsidian。') : reading?.status === 'complete' ? '全文、指南与阅读重点已保存。' : '首次点击生成，之后自动读取已保存内容。');
  $('stop-chat').hidden = !next.busyChat; $('send').disabled = !next.connected || !!next.busyChat;
  $('selection').hidden = !next.selected; $('selection-text').textContent = next.selected?.text?.slice(0, 240) || '';
  renderChat(next.chat || []); renderGuide(reading?.guide || null, reading?.figureNotes || []);
  if (next.panelCommand?.id && next.panelCommand.id !== lastCommand) {
    lastCommand = next.panelCommand.id; selectTab(next.panelCommand.tab || 'chat');
    if (next.panelCommand.prompt) $('question').value = next.panelCommand.prompt;
    if (next.panelCommand.focus) $('question').focus();
  }
}
document.addEventListener('znr-state', event => { try { render(JSON.parse(event.detail)); } catch (error) { $('error').hidden = false; $('error').textContent = String(error); } });
ZNRPanelSelection.init(()=>state);
$('paper-overview').addEventListener('toggle', () => {
  const value = $('paper-overview').open;
  if (value === !!state.appearance?.overviewExpanded) return;
  state.appearance = { ...state.appearance, overviewExpanded: value };
  ZNR.action('appearance', { appearance: { overviewExpanded: value } });
});
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => selectTab(button.dataset.tab));
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { $('question').value = button.dataset.prompt; $('question').focus(); });
for (const [id, action, data] of [['reconnect','reconnect',{}],['collapse','collapse',{}],['settings','settings',{}],['open-note','open-note',{}],['generate','generate',{}],['cancel-reading','cancel',{kind:'reading'}],['stop-chat','cancel',{kind:'chat'}],['mode-pdf','mode',{mode:'pdf'}],['mode-bilingual','mode',{mode:'bilingual'}],['clear-selection','selection',{selection:null}]]) $(id).addEventListener('click', () => ZNR.action(action, data));
$('chat-form').addEventListener('submit', event => {
  event.preventDefault(); const question = $('question').value.trim();
  if (!question || sending || state.busyChat) return;
  sending = true; $('send').disabled = true; $('question').value = ''; selectTab('chat'); ZNR.action('chat', { question });
});
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
document.addEventListener('DOMContentLoaded', () => ZNR.action('ready'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => ZNR.theme(state.appearance?.theme || 'system'));
document.documentElement.setAttribute('data-panel-ready', '1');
