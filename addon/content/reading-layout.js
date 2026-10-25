(function (root) {
  'use strict';
  // Presentation only: keep every source ID and translation intact in the archive.
  function layoutReading(blocks, title = '', authors = [], layout = {}) {
    const figures = blocks.filter(block => block.asset && ['figure', 'table', 'equation'].includes(block.type));
    const groups = new Map(), owners = new Map();
    const metadata = root.PaperMetadata.classify(blocks, title, authors);
    const metadataIds = new Set(metadata.ids), metadataKey = metadata.ids.length ? 'authors-' + (metadata.authorId || metadata.ids[0]) : null;
    const add = (key, block) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(block); owners.set(block.id, key); };
    for (const block of blocks) {
      if (metadataIds.has(block.id)) { add(metadataKey, block); continue; }
      if (!block.original || block.asset || ['heading', 'caption'].includes(block.type)) continue;
      const text = block.original.trim(), box = block.bbox;
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
      else if (block.type === 'note' && (text.length <= 180 || /©|all rights reserved/i.test(text))) add('notes-' + block.page, block);
    }
    // PDF columns/pages are physical boundaries, not paragraph boundaries.
    // Join only incomplete prose with matching geometry and mapped text faces.
    const continuations = new Map(), continuationOwners = new Map();
    const flow = blocks.filter(b=>!owners.has(b.id)&&!b.asset&&!b.visualParentId&&['paragraph','heading'].includes(b.type));
    const joins = (a,b) => {
      if(a.type!=='paragraph'||b.type!=='paragraph'||!a.bbox||!b.bbox)return false;
      const left=a.original?.trim()||'',right=b.original?.trim()||'';
      if(left.length<50||right.length<40||/[.!?。！？][\s\]”"’')]*$/.test(left)||! /^[a-z0-9(]/.test(right))return false;
      const la=layout.blocks?.[a.id],lb=layout.blocks?.[b.id],pa=layout.pages?.[a.page],pb=layout.pages?.[b.page];
      if(!la?.mapped||!lb?.mapped||!pa||!pb||pa.rotation||pb.rotation)return false;
      if(!la.baseSize||Math.abs(la.baseSize-lb.baseSize)>la.baseSize*.12)return false;
      const aw=a.bbox[2]-a.bbox[0],bw=b.bbox[2]-b.bbox[0];
      if(aw<pa.width*.28||bw<pb.width*.28||Math.abs(aw-bw)>Math.max(aw,bw)*.2)return false;
      const last=la.chars?.findLast(c=>c.rect&&c.end>=left.length-2),first=lb.chars?.find(c=>c.rect&&c.start<2);
      // A short final line or an indented new paragraph is not a continuation.
      if(!last||!first||last.rect[2]<a.bbox[2]-aw*.13||first.rect[0]>b.bbox[0]+lb.baseSize*.65)return false;
      if(a.page===b.page){
        const nextColumn=b.bbox[0]>a.bbox[2]-4&&b.bbox[1]<a.bbox[1]-la.baseSize;
        const adjacentLine=Math.abs(b.bbox[0]-a.bbox[0])<la.baseSize*.65&&b.bbox[1]>=a.bbox[3]-1&&b.bbox[1]-a.bbox[3]<la.baseSize*.7;
        return nextColumn||adjacentLine;
      }
      return b.page===a.page+1&&a.bbox[3]>pa.height*.55;
    };
    for(let i=1;i<flow.length;i++){
      const a=flow[i-1],b=flow[i];if(!joins(a,b))continue;
      const key=continuationOwners.get(a.id)||a.id;
      if(!continuations.has(key)){continuations.set(key,[a]);continuationOwners.set(a.id,key);}
      continuations.get(key).push(b);continuationOwners.set(b.id,key);
    }
    return { groups, owners, continuations, continuationOwners, titleId: metadata.titleId, authorId: metadata.authorId, metadataKey };
  }
  root.ZNRLayout = { layoutReading };
})(globalThis);
