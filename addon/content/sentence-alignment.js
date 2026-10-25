(function(root){
  'use strict';
  const VERSION=1;
  // All offsets refer to the unchanged canonical strings (UTF-16), never a
  // normalized copy. No word-for-word equivalence is claimed across languages.
  function sentences(text,language){
    text=String(text||'');const result=[],stack=[];let start=0;
    const push=end=>{let a=start,b=end;while(a<b&&/\s/.test(text[a]))a++;while(b>a&&/\s/.test(text[b-1]))b--;if(b>a)result.push({start:a,end:b,text:text.slice(a,b)});start=end;};
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if('（(['.includes(c)){stack.push(c);continue;}
      if('）)]'.includes(c)){if(stack.length)stack.pop();continue;}
      if(stack.length)continue;
      let end=/[。！？!?]/.test(c);
      if(c==='.'&&language==='original'){
        const before=text.slice(start,i),next=text.slice(i+1);
        const word=before.match(/([A-Za-z]+)$/)?.[1]||'';
        const abbreviation=/^(?:figs?|eqs?|refs?|dr|mr|mrs|ms|prof|vs|etc|al|syn|no|nos|vol|pp|e|g|i)$/i.test(word)||/^[A-Z]$/.test(word);
        end=!abbreviation&&!(/\d$/.test(before)&&/^\d/.test(next))&&(!next.trim()||/^\s+[A-Z\d\u0391-\u03a9]/.test(next));
      }
      if(end){let j=i+1;while(j<text.length&&/[。！？!?"”’]/.test(text[j]))j++;push(j);i=j-1;}
    }
    push(text.length);return result;
  }
  function translatorNotes(text){
    // Translator explanations are not evidence for a source sentence. Keep
    // ordinary scientific parentheses (counts, abbreviations and citations).
    const ranges=[];let i=0;
    while(i<text.length){
      if(/[（(]/.test(text[i])&&/^(?:原文|译注|本句|本段)/.test(text.slice(i+1).trimStart())){
        const start=i;let depth=1;i++;while(i<text.length&&depth){if(/[（(]/.test(text[i]))depth++;else if(/[）)]/.test(text[i]))depth--;i++;}ranges.push({start,end:i});
      }else i++;
    }return ranges;
  }
  function withoutNotes(text){let out='',start=0;for(const r of translatorNotes(text)){out+=text.slice(start,r.start);start=r.end;}return out+text.slice(start);}
  function anchors(text){
    const normalized=withoutNotes(text).normalize('NFKC').replace(/(\d),(?=\d{3}(?:\D|$))/g,'$1').toLowerCase();
    return new Set((normalized.match(/[a-z]+[a-z\d]*(?:[-_][a-z\d]+)*|\d+(?:\.\d+)?/g)||[])
      .filter(x=>/\d/.test(x)||x.length>1&&!/^(?:id|syn|et|al|fig|figure|table|ref|the|and|or|of|in|to|for)$/.test(x)));
  }
  const union=sets=>new Set(sets.flatMap(s=>[...s]));
  function align(block){
    const original=sentences(block?.original,'original'),translation=sentences(block?.translation,'translation');
    const en=original.map(s=>anchors(s.text)),zh=translation.map(s=>anchors(s.text)),all=union(en),pairs=translation.map(()=>null);
    for(let j=0;j<translation.length;j++){
      const keys=[...zh[j]].filter(k=>all.has(k));if(!keys.length)continue;
      // New numbers introduced by a paraphrase/translator must not be silently
      // attributed to a different source sentence.
      if([...zh[j]].some(k=>/^\d/.test(k)&&!all.has(k)))continue;
      const candidates=[];
      for(let a=0;a<en.length;a++)for(let b=a;b<Math.min(en.length,a+3);b++){
        const found=union(en.slice(a,b+1));
        if(keys.every(k=>found.has(k))&&keys.some(k=>en[a].has(k))&&keys.some(k=>en[b].has(k)))candidates.push({a,b});
      }
      const minimum=Math.min(...candidates.map(c=>c.b-c.a)),best=candidates.filter(c=>c.b-c.a===minimum);
      if(best.length===1)pairs[j]={...best[0],evidence:'anchors'};
    }
    // Fill only equal, order-consistent sentence structures supported by a
    // content anchor. Count/length alone cannot establish semantic equivalence.
    const ordered=original.length===translation.length&&pairs.some(Boolean)&&pairs.every((p,i)=>!p||p.a===i&&p.b===i);
    if(ordered)for(let i=0;i<pairs.length;i++)if(!pairs[i]&&[...zh[i]].every(k=>!all.has(k)||en[i].has(k))
      &&![...zh[i]].some(k=>/^\d/.test(k)&&!en[i].has(k)))pairs[i]={a:i,b:i,evidence:'sentence-order'};
    if(original.length===1&&translation.length===1)pairs[0]={a:0,b:0,evidence:'single-sentence'};
    return {original,translation,pairs};
  }
  function merge(ranges){
    const result=[];
    for(const r of ranges.sort((a,b)=>a.start-b.start)){const last=result.at(-1);if(last&&r.start<=last.end)last.end=Math.max(last.end,r.end);else result.push({...r});}
    return result;
  }
  function resolve(block,segments){
    const model=align(block),ranges=[],evidence=new Set();
    const unknown=()=>({version:VERSION,mode:'unresolved',ranges:[],text:'',reason:'未能可靠匹配英文句子'});
    if(!segments?.length||!model.original.length)return unknown();
    for(const s of segments){
      if(translatorNotes(block.translation).some(r=>s.start>=r.start&&s.end<=r.end))return unknown();
      const touched=model.translation.map((row,i)=>({row,i})).filter(({row})=>s.start<row.end&&s.end>row.start
        &&/[\p{L}\p{N}]/u.test(block.translation.slice(Math.max(s.start,row.start),Math.min(s.end,row.end))));
      if(!touched.length)return unknown();
      for(const {i} of touched){const p=model.pairs[i];if(!p)return unknown();ranges.push({start:model.original[p.a].start,end:model.original[p.b].end});evidence.add(p.evidence);}
    }
    const merged=merge(ranges);
    return {version:VERSION,mode:'sentence',ranges:merged,text:merged.map(r=>block.original.slice(r.start,r.end)).join('\n'),evidence:[...evidence]};
  }
  const api={VERSION,sentences,align,resolve,merge};root.ZNRSentenceAlignment=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
