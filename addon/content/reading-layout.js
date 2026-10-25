(function (root) {
  'use strict';
  const PaperMetadata = typeof module !== 'undefined' && module.exports ? require('./paper-metadata.js') : root.PaperMetadata;
  const FLOW_VERSION = 2;
  // Shared logical reading structure; canonical strings and IDs never change.
  function layoutReading(blocks, title = '', authors = [], layout = {}, confirmedFlow = null) {
    layout ||= {};
    const figures = blocks.filter(block => block.asset && ['figure', 'table', 'equation'].includes(block.type));
    const groups = new Map(), owners = new Map();
    const metadata = PaperMetadata.classify(blocks, title, authors);
    const metadataIds = new Set(metadata.ids);
    let metadataKey = metadata.ids.length ? 'authors-' + (metadata.authorId || metadata.ids[0]) : null;
    const add = (key, block) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(block); owners.set(block.id, key); };
    for (const block of blocks) {
      if (metadataIds.has(block.id)) { add(metadataKey, block); continue; }
      if (!block.original || block.asset || ['heading', 'caption'].includes(block.type)) continue;
      const text = block.original.trim(), box = block.bbox;
      const page = layout.pages?.[block.page];
      const runningHeader = page && box?.length === 4 && box[3] < page.height * .065 && text.length < 180
        && (/^[\p{L}.\s'-]+\bet al\./u.test(text) || /\b\d+\s*\(\d{4}\)\s*\d+[–-]\d+\s*$/.test(text));
      if (runningHeader) { add('notes-' + block.page, block); continue; }
      // Narrow, short fragments beside graphics are labels, not prose. A full
      // column of text and complete sentences remain in the reading flow.
      const fragment = text.length <= 180 && text.split(/\s+/).length <= 24 && !/[.!?。！？]["”']?$/.test(text);
      let nearest = null, distance = Infinity;
      const completeFigure = box?.length === 4 && figures.find(figure => figure.captionIds?.length && figure.page === block.page && figure.bbox
        && box[0] >= figure.bbox[0] - 1 && box[1] >= figure.bbox[1] - 1 && box[2] <= figure.bbox[2] + 1 && box[3] <= figure.bbox[3] + 1);
      if (completeFigure) { add('graphic-' + completeFigure.id, block); continue; }
      if (fragment && box?.length === 4 && box[2] - box[0] <= 185 && box[3] - box[1] <= 60) {
        for (const figure of figures) {
          if (figure.page !== block.page || !figure.bbox || figure.captionIds?.length) continue;
          const area = figure.bbox;
          const dx = Math.max(area[0] - box[2], box[0] - area[2], 0);
          const dy = Math.max(area[1] - box[3], box[1] - area[3], 0);
          if (dx <= 165 && dy <= 22 && dx + dy * 4 < distance) { nearest = figure; distance = dx + dy * 4; }
        }
      }
      if (nearest) add('graphic-' + nearest.id, block);
      else if (block.type === 'note') add('notes-' + block.page, block);
    }
    // PDF boxes are physical fragments. Use actual glyph rows, not overlapping
    // text-box edges or the case/length of the next word, to recognize a join.
    const continuations = new Map(), continuationOwners = new Map();
    const flow = blocks.filter(b=>!owners.has(b.id)&&!b.asset&&!b.visualParentId&&['paragraph','heading'].includes(b.type));
    const rowCache = new Map();
    const geometry = block => {
      if (rowCache.has(block.id)) return rowCache.get(block.id);
      const mapped = layout.blocks?.[block.id], text = block.original || '';
      const chars = mapped?.mapped && mapped.chars?.filter(c=>c.rect && text.slice(c.start,c.end).trim());
      if (!chars?.length || chars.some(c=>c.rect.some(n=>!Number.isFinite(n)) || c.rect[2]<c.rect[0] || c.rect[3]<=c.rect[1])) { rowCache.set(block.id,null); return null; }
      const rows = new Map();
      for (const c of chars) {
        const key = c.line ?? Math.round((c.rect[1]+c.rect[3])/(mapped.baseSize||1));
        if (!rows.has(key)) rows.set(key,[...c.rect]);
        else { const r=rows.get(key);r[0]=Math.min(r[0],c.rect[0]);r[1]=Math.min(r[1],c.rect[1]);r[2]=Math.max(r[2],c.rect[2]);r[3]=Math.max(r[3],c.rect[3]); }
      }
      const values=[...rows.values()], centers=values.map(r=>(r[1]+r[3])/2);
      const steps=centers.slice(1).map((y,i)=>Math.abs(y-centers[i])).filter(n=>n>mapped.baseSize*.75&&n<mapped.baseSize*2.5).sort((a,b)=>a-b);
      const result={mapped,first:chars[0],last:chars.at(-1),firstRow:values[0],lastRow:values.at(-1),leading:steps.length?steps[Math.floor(steps.length/2)]:mapped.baseSize*1.3};
      rowCache.set(block.id,result);return result;
    };
    const heading = block => block.type==='heading' || (block.original?.length<220 && /^\s*\d+(?:\.\d+)+\.?\s+[A-Z][A-Za-z-]+\b/.test(block.original));
    const joins = (a,b,prior) => {
      if(a.type!=='paragraph'||b.type!=='paragraph'||!a.bbox||!b.bbox)return false;
      if(heading(a)||heading(b))return false;
      const ga=geometry(a),gb=geometry(b),pa=layout.pages?.[a.page],pb=layout.pages?.[b.page];
      if(!ga||!gb||!pa||!pb||pa.rotation||pb.rotation)return false;
      const size=ga.mapped.baseSize;
      if(!size||Math.abs(size-gb.mapped.baseSize)>size*.12)return false;
      const bounds=[...a.bbox];
      // A PDF may split a line at a font change (grant IDs, accessions, units).
      // Keep the original column bounds while following these narrow fragments.
      for(const part of prior){
        if(part.page!==a.page||!part.bbox)continue;
        const overlap=Math.min(bounds[2],part.bbox[2])-Math.max(bounds[0],part.bbox[0]);
        if(overlap>=Math.min(bounds[2]-bounds[0],part.bbox[2]-part.bbox[0])*.65){bounds[0]=Math.min(bounds[0],part.bbox[0]);bounds[2]=Math.max(bounds[2],part.bbox[2]);}
      }
      const overlap=Math.min(bounds[2],b.bbox[2])-Math.max(bounds[0],b.bbox[0]);
      const sameColumn=overlap>=Math.min(bounds[2]-bounds[0],b.bbox[2]-b.bbox[0])*.65;
      const center=r=>(r[1]+r[3])/2;
      const advance=center(ga.lastRow)-center(gb.firstRow);
      const inline=a.page===b.page&&sameColumn&&Math.abs(advance)<size*.4
        &&gb.first.rect[0]>=ga.last.rect[2]-.5&&gb.first.rect[0]-ga.last.rect[2]<=size*3;
      if(inline)return true;
      const left=a.original?.trimEnd()||'',right=b.original?.trimStart()||'';
      const abbreviation=/(?:\b[A-Z]|\bet al|\be\.g|\bi\.e|\bFig|\bEq|\bRef)\.$/.test(left);
      if(!right||! /^[\p{L}\p{N}(\[]/u.test(right)||(!abbreviation&&/[.!?。！？][\s\]”"’')]*$/.test(left)))return false;
      const width=bounds[2]-bounds[0];
      if(width<pa.width*.28||ga.last.rect[2]<bounds[2]-width*.13||gb.first.rect[0]>b.bbox[0]+gb.mapped.baseSize*.65)return false;
      if(a.page===b.page){
        const nextColumn=b.bbox[0]>bounds[2]-1&&center(gb.firstRow)>=center(ga.lastRow)-size;
        const leading=(ga.leading+gb.leading)/2;
        const adjacentLine=sameColumn&&Math.abs(b.bbox[0]-bounds[0])<size*.65&&advance>=leading*.65&&advance<=leading*1.5;
        return nextColumn||adjacentLine;
      }
      // Adjacent in the verified body flow: a figure can occupy the remainder
      // of a page, so a fixed "bottom 45%" requirement loses real continuations.
      return b.page===a.page+1&&prior.reduce((n,part)=>n+(part.original?.length||0),0)>=50;
    };
    for(let i=1;i<flow.length;i++){
      const a=flow[i-1],b=flow[i],prior=continuations.get(continuationOwners.get(a.id))||[a];if(!joins(a,b,prior))continue;
      const key=continuationOwners.get(a.id)||a.id;
      if(!continuations.has(key)){continuations.set(key,[a]);continuationOwners.set(a.id,key);}
      continuations.get(key).push(b);continuationOwners.set(b.id,key);
    }
    // The confirmed structure is cached with the reading. It remains usable
    // offline and prevents the UI and archive deriving different groupings.
    if(confirmedFlow?.version===FLOW_VERSION&&Array.isArray(confirmedFlow.paragraphs)&&Array.isArray(confirmedFlow.folded)){
      const byId=new Map(blocks.map(b=>[b.id,b])),seen=new Set();
      const foldedValid=confirmedFlow.folded.every(g=>g&&/^(?:authors-|notes-|graphic-)[a-zA-Z0-9_-]+$/.test(g.key)&&Array.isArray(g.ids)&&g.ids.every(id=>{
        if(!byId.has(id)||seen.has(id))return false;seen.add(id);return true;
      }));
      const valid=foldedValid&&confirmedFlow.paragraphs.every(ids=>Array.isArray(ids)&&ids.length>1&&ids.every((id,i)=>{
        const b=byId.get(id);if(!b||b.type!=='paragraph'||seen.has(id)||(i&&b.order<=byId.get(ids[i-1]).order))return false;
        seen.add(id);return true;
      }));
      if(valid){
        continuations.clear();continuationOwners.clear();groups.clear();owners.clear();
        for(const group of confirmedFlow.folded)for(const id of group.ids)add(group.key,byId.get(id));
        metadataKey=confirmedFlow.folded.find(g=>g.key.startsWith('authors-'))?.key||null;
        for(const ids of confirmedFlow.paragraphs){continuations.set(ids[0],ids.map(id=>byId.get(id)));for(const id of ids)continuationOwners.set(id,ids[0]);}
      }
    }
    return { groups, owners, continuations, continuationOwners, titleId: metadata.titleId, authorId: metadata.authorId, metadataKey };
  }
  // Only hide explicit legacy layout commentary at a verified join. Keep
  // canonical UTF16 ranges so existing selections and annotations still work.
  function translationSpans(blocks) {
    const spans=[];
    // PDF-boundary notes sometimes quote Latin units with nested parentheses.
    // Parse balanced parentheses; never use a broad regex to strip science.
    const parentheses=text=>{
      const result=[],stack=[];let quote=null;
      for(let i=0;i<text.length;i++){
        if(quote){if(text[i]===quote)quote=null;continue;}
        if(text[i]==='“'||text[i]==='‘'||text[i]==='"'){quote=text[i]==='“'?'”':text[i]==='‘'?'’':'"';continue;}
        if(text[i]==='('||text[i]==='（')stack.push(i);
        else if((text[i]===')'||text[i]==='）')&&stack.length){const start=stack.pop();result.push({start,end:i+1,text:text.slice(start,i+1)});}
      }
      return result.sort((a,b)=>a.start-b.start||b.end-a.end);
    };
    return blocks.map((block, index) => {
      const text = block.translation || ''; let start = 0, end = text.length; const notes = [];
      const boundary = (value,neighbors) => /^[（(]\s*(?:本[句段]|原文)/.test(value)
        && neighbors.some(b=>new RegExp('(?:^|[^A-Za-z0-9_-])'+b.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^A-Za-z0-9_-])').test(value))
        && /承接|下接/.test(value) && /段|分栏|截断|中断/.test(value);
      const ranges=parentheses(text),previous=index?displayRanges(spans[index-1]).map(r=>(blocks[index-1].translation||'').slice(r.start,r.end)).join(''):'';
      if (index) {
        for(const range of ranges){
          if(range.start>80)break;
          if(!boundary(range.text,blocks.slice(0,index))||!/承接/.test(range.text))continue;
          const before=text.slice(0,range.start).trim();
          if(before&&!(before.length<=40&&/[\u3400-\u9fff]/.test(before)&&previous.trimEnd().endsWith(before)))continue;
          notes.push(range.text);start=range.end;
          const ellipsis = text.slice(start).match(/^\s*(?:……|\.\.\.)?\s*/);start+=ellipsis[0].length;break;
        }
      }
      if (index < blocks.length - 1) {
        const suffix=ranges.find(r=>r.start>=start&&!text.slice(r.end).trim()&&boundary(r.text,blocks.slice(index+1))&&/下接/.test(r.text));
        if(suffix){end=suffix.start;notes.push(suffix.text);}
      }
      if (index) {
        for (let n = Math.min(40, previous.length, end - start); n >= 2; n--) {
          const word = text.slice(start, start + n);
          if (/^[\p{L}\p{N}（）()\s-]+$/u.test(word) && (word.match(/[\u3400-\u9fff]/g)||[]).length>=2 && previous.endsWith(word)) { start += n; break; }
        }
      }
      const span={start,end,notes},visible=[];let cursor=start;
      for(const range of ranges){
        const peers=/下接/.test(range.text)?blocks.slice(index+1):blocks.slice(0,index);
        if(range.start<cursor||range.end>end||!boundary(range.text,peers))continue;
        if(range.start>cursor)visible.push({start:cursor,end:range.start});cursor=range.end;
        if(!notes.includes(range.text))notes.push(range.text);
      }
      if(cursor>start){if(cursor<end)visible.push({start:cursor,end});span.ranges=visible;}
      spans.push(span);return span;
    });
  }
  function displayRanges(span){return span.ranges||[{start:span.start,end:span.end}];}
  function readingFlow(blocks, title, authors, layout) {
    const plan = layoutReading(blocks, title, authors, layout);
    return {version: FLOW_VERSION, paragraphs: [...plan.continuations.values()].map(group => group.map(b => b.id)),
      folded: [...plan.groups.entries()].map(([key, group]) => ({key, ids: group.map(b => b.id)}))};
  }
  function separator(previous,next,language){return language==='original'?(/[-\u2010\u2212]$/.test(previous)?'':' '):(/[\u3400-\u9fff]$/.test(previous)&&/^[\u3400-\u9fff]/.test(next)?'':' ');}
  const api = { FLOW_VERSION, layoutReading, translationSpans, displayRanges, readingFlow, separator };
  root.ZNRLayout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
