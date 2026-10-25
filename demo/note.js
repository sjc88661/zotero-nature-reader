'use strict';
(async()=>{
  const raw=await fetch('/demo/sample-note.md').then(r=>r.text());
  const text=raw.replace(/^---[\s\S]*?\n---\n/,'').replace(/<!--.*?-->/g,'');
  const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const inline=s=>esc(s).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\[([^\]]+)\]\([^)]*\)/g,'<a href="#" title="演示链接">$1</a>').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g,'<a href="#">$2</a>');
  const root=document.getElementById('note'),toc=document.getElementById('toc');let count=0;
  for(const line of text.split('\n')){
    if(!line.trim()||line.startsWith('^')||line.startsWith('|'))continue;
    const heading=line.match(/^(#{1,6}) (.+)$/),image=line.match(/^!\[\[([^\]]+)\]\]/);let el;
    if(heading){el=document.createElement('h'+heading[1].length);el.innerHTML=inline(heading[2]);if(heading[1].length===2){el.id='section-'+count++;const a=document.createElement('a');a.href='#'+el.id;a.textContent=heading[2];toc.append(a);}}
    else if(image){el=document.createElement('img');el.src='/demo/assets/figure.svg';el.alt='演示图表';}
    else if(line==='---')el=document.createElement('hr');
    else{el=document.createElement(line.startsWith('>')?'blockquote':'p');el.innerHTML=inline(line.replace(/^> ?/,''));}
    root.append(el);
  }
  window.noteReady=true;
})();
