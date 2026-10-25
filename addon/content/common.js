'use strict';
window.ZNR = {
  element(tag, text, className) {
    const node = document.createElementNS('http://www.w3.org/1999/xhtml', tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  },
  action(action, data = {}) { document.documentElement.setAttribute('data-last-action', action); document.dispatchEvent(new CustomEvent('znr-action', { detail: JSON.stringify({ action, ...data }) })); },
  theme(value = 'system') { document.documentElement.dataset.theme = value === 'dark' || value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; },
  inline(parent, text) {
    const tokens = String(text || '').split(/(\*\*[^*]+\*\*|`[^`]+`|\[[A-Z]\d+\s+p\.\d+\])/g);
    for (const token of tokens) {
      if (token.startsWith('**') && token.endsWith('**')) parent.append(this.element('strong', token.slice(2, -2)));
      else if (token.startsWith('`') && token.endsWith('`')) parent.append(this.element('code', token.slice(1, -1)));
      else if (/^\[([A-Z]\d+)\s+p\.(\d+)\]$/.test(token)) {
        const match = token.match(/^\[([A-Z]\d+)\s+p\.(\d+)\]$/);
        const link = this.element('button', `${match[1]} · p.${match[2]}`, 'source-link');
        link.title = '定位到双语正文';
        link.addEventListener('click', () => this.action('locate', { blockId: match[1], page: Number(match[2]) })); parent.append(link);
      } else parent.append(document.createTextNode(token));
    }
  },
  generated(parent, block, annotations = []) {
    const body=this.element('div',undefined,'generated-text');
    body.dataset.blockId=block.id;body.dataset.page=block.page;body.dataset.language='readingNote';
    this.markdown(body,block.readingNote.text);
    const text=body.textContent, ranges=annotations.flatMap(a=>(a.segments||[])
      .filter(s=>s.blockId===block.id&&s.language==='readingNote'&&s.sourceText===text)
      .map(s=>({...s,key:a.key,color:a.color})));
    const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),leaves=[];let leaf,offset=0;
    while((leaf=walker.nextNode())){leaves.push({leaf,start:offset});offset+=leaf.length;}
    for(const {leaf,start} of leaves){
      const active=ranges.filter(r=>r.start<start+leaf.length&&r.end>start);if(!active.length)continue;
      const cuts=[...new Set([0,leaf.length,...active.flatMap(r=>[Math.max(0,r.start-start),Math.min(leaf.length,r.end-start)])])].sort((a,b)=>a-b);
      const fragment=document.createDocumentFragment();
      for(let i=1;i<cuts.length;i++){
        const a=cuts[i-1],b=cuts[i],matches=active.filter(r=>r.start<start+b&&r.end>start+a);
        if(!matches.length)fragment.append(document.createTextNode(leaf.data.slice(a,b)));
        else {const span=this.element('span',leaf.data.slice(a,b),'user-highlight');span.dataset.annotationKeys=matches.map(r=>r.key).join(',');span.style.setProperty('--mark-color',matches[0].color);fragment.append(span);}
      }
      leaf.replaceWith(fragment);
    }
    parent.append(body);return body;
  },
  markdown(parent, text) {
    let list = null, code = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      if (/^```/.test(line)) { if (code) code = null; else { code = this.element('pre'); parent.append(code); } continue; }
      if (code) { code.textContent += line + '\n'; continue; }
      const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (bullet) { if (!list) { list = this.element('ul'); parent.append(list); } const item = this.element('li'); this.inline(item, bullet[1]); list.append(item); continue; }
      list = null;
      if (!line.trim()) continue;
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      const node = this.element(heading ? 'h3' : 'p'); this.inline(node, heading ? heading[1] : line); parent.append(node);
    }
  }
};
