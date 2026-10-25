// Asset-only migration: paid text, stable IDs, guide and conversations are immutable.
export function applyVisualRepair(original, manifest) {
  if (original.key !== manifest.key || original.fingerprint !== manifest.fingerprint
    || original.reading?.revision !== manifest.baseReadingRevision) throw new Error('文献或修订已经变化，未应用图片修复。');
  if (original.reading.status !== 'complete' || original.chat.some(r => ['pending','streaming'].includes(r.status))) throw new Error('请等待当前任务完成后修复图片。');
  const doc = structuredClone(original);
  const apply = blocks => {
    const result = structuredClone(blocks);
    for (const patch of manifest.changes) {
      const existing = result.find(b => b.id === patch.id);
      if (existing) {
        if (!['figure','table','equation'].includes(existing.type) || existing.original || existing.translation) throw new Error('禁止改写文字块。');
        for (const key of Object.keys(patch)) if (!['id','type','page','bbox','asset','captionIds','confidence','visualParentId'].includes(key)) throw new Error('图片补丁包含非显示字段。');
        Object.assign(existing, patch); if (patch.asset === null) delete existing.asset;
      } else {
        if (!/^[FTE]\d+$/.test(patch.id) || patch.original !== '' || patch.translation !== '' || !patch.asset) throw new Error('新增块只能是无文字的原图。');
        const index = result.findIndex(b => b.id === patch.insertBefore);
        if (index < 0) throw new Error('新增图表缺少有效图注。');
        const {insertBefore,...block} = patch; result.splice(index,0,block);
      }
    }
    result.forEach((b,i)=>b.order=i);
    for (const old of blocks) {
      const next = result.find(b=>b.id===old.id);
      if (!next || next.original !== old.original || next.translation !== old.translation) throw new Error('源文或已有译文发生变化，已停止修复。');
    }
    return result;
  };
  doc.reading.blocks = apply(doc.reading.blocks);
  doc.source.blocks = apply(doc.source.blocks);
  const used = new Set(doc.reading.blocks.map(b=>b.asset).filter(Boolean));
  const assets = new Map([...doc.reading.assets, ...manifest.assets].map(a=>[a.name,a]));
  doc.reading.assets = [...used].map(name=>{ if(!assets.has(name)) throw new Error('缺少原图资产。'); return assets.get(name); });
  doc.source.assets = structuredClone(doc.reading.assets);
  doc.reading.totalBlocks = doc.reading.blocks.length;
  doc.reading.doneBlocks = doc.reading.blocks.filter(b=>b.status==='complete').length;
  return doc;
}
