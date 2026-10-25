import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const { LAYOUT_VERSION, LAYOUT_MAPPING_VERSION, layoutContentHash } = await import(
  new URL(`./layout.mjs${new URL(import.meta.url).search}`, import.meta.url).href);
const {READING_ORDER_VERSION} = await import(new URL(`./reading-order.mjs${new URL(import.meta.url).search}`,import.meta.url).href);
const {readingFlow} = await import(new URL(`./reading-flow.mjs${new URL(import.meta.url).search}`, import.meta.url).href);

export const PROTOCOL_VERSION = 1;
export const VERSION = '0.2.9';
const clone = value => structuredClone(value);
const interrupted = new Set(['pending', 'streaming', 'extracting', 'translating']);

export function paperIdentity(paper) {
  if (!Number.isInteger(paper?.libraryID) || !/^[A-Z0-9]{8}$/.test(paper?.itemKey)) throw new Error('文献缺少有效的 Zotero 标识。');
  return `${paper.libraryID}:${paper.itemKey}`;
}

export async function fingerprint(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function parseJSON(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); }
  catch {
    const from = cleaned.indexOf('{'), to = cleaned.lastIndexOf('}');
    if (from >= 0 && to > from) {
      const candidate = cleaned.slice(from, to + 1);
      try { return JSON.parse(candidate); }
      catch (error) {
        // Some model responses close {overview:...} before the other guide fields.
        // Remove only that proven top-level boundary, then require strict JSON.
        let depth = 0, quoted = false, escaped = false;
        for (let index = 0; index < candidate.length; index++) {
          const char = candidate[index];
          if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
          if (char === '"') { quoted = true; continue; }
          if (char === '{') depth++;
          if (char === '}' && --depth === 0) {
            const head = JSON.parse(candidate.slice(0, index + 1)), tail = candidate.slice(index + 1);
            if (typeof head.overview === 'string' && Object.keys(head).every(key => ['overview','readingOrder','highlights','glossary'].includes(key))
              && /^,\s*"(?:readingOrder|highlights|glossary)"\s*:/.test(tail)) return JSON.parse(candidate.slice(0, index) + tail);
            break;
          }
        }
        throw error;
      }
    }
    throw new Error('模型未返回完整 JSON；已有内容已保存，可继续生成。');
  }
}

export function translationBatches(blocks, limit = 6000, paragraphs = []) {
  const batches = [];
  let batch = [], size = 0;
  const byId = new Map(blocks.map(b => [b.id,b])), owners = new Map(), consumed = new Set();
  for (const group of paragraphs) for (const id of group) owners.set(id,group);
  for (const block of blocks) {
    if (consumed.has(block.id)) continue;
    const group = (owners.get(block.id) || [block.id]).map(id => byId.get(id)).filter(Boolean);
    for (const member of group) consumed.add(member.id);
    const pending = group.filter(b => b.status !== 'complete' && b.original?.trim() && !['figure','table','equation'].includes(b.type));
    if (!pending.length) continue;
    const length = pending.reduce((sum,b) => sum + b.original.length,0);
    if (batch.length && size + length > limit) { batches.push(batch); batch = []; size = 0; }
    batch.push(...pending); size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function makeExtractor(python, script) {
  return (pdf, directory, signal) => new Promise((resolve, reject) => {
    const child = spawn(python, [script, '--pdf', pdf, '--out', directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '', errors = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { output += text; });
    child.stderr.on('data', text => { errors = (errors + text).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(errors || `PDF 解析进程退出（${code}）。`));
      else {
        try { resolve(JSON.parse(output)); }
        catch { reject(new Error('PDF 解析器未返回有效结果：' + output.slice(-300))); }
      }
    });
  });
}

export class ReadingEngine {
  constructor({ workRoot, model, extract, enrichLayout = null, reorder = null, log = () => {} }) {
    this.workRoot = path.resolve(workRoot); this.model = model; this.extract = extract; this.enrichLayout = enrichLayout; this.reorder = reorder; this.log = log;
    this.documents = new Map(); this.opening = new Map(); this.jobs = new Map(); this.saves = new Map(); this.extractions = new Map(); this.closed = false;
    this.layouts = new Map(); this.layoutJobs = new Map();
    this.readingSaves = new Map();
    this.extractionController = new AbortController();
  }

  async start() {
    await mkdir(this.workRoot, { recursive: true });
    for (const entry of await readdir(this.workRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.workRoot, entry.name, 'document.json');
      try {
        const doc = JSON.parse(await readFile(file, 'utf8'));
        if (doc.version !== 1 || doc.key !== entry.name || paperIdentity(doc.paper) !== doc.paperId) continue;
        doc.directory = path.dirname(file); doc.chat ||= []; doc.sessions ||= {};
        for (const record of doc.chat) if (interrupted.has(record.status)) {
          record.status = 'interrupted'; record.error = 'Harness 已重启，可重新提问。'; record.updatedAt = Date.now();
        }
        if (doc.reading && interrupted.has(doc.reading.status)) {
          doc.reading.status = 'interrupted'; doc.reading.error = '生成已中断，点击“继续精读”可接续。'; doc.reading.revision++; doc.reading.updatedAt = Date.now();
        }
        this.documents.set(doc.key, doc);
        try { if (await this.migrateReadingOrder(doc)) continue; }
        catch (error) { doc.readingOrderError = '阅读顺序尚未校正，请重新打开文献：' + error.message; this.log(error); }
        await this.save(doc);
      } catch (error) { if (error.code !== 'ENOENT') this.log(error); }
    }
  }

  async save(doc) {
    doc.revision = (doc.revision || 0) + 1;
    const text = JSON.stringify(doc);
    const file = path.join(doc.directory, 'document.json');
    const previous = this.saves.get(doc.key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      await mkdir(doc.directory, { recursive: true });
      await writeFile(file + '.tmp', text, 'utf8');
      await rename(file + '.tmp', file);
    });
    this.saves.set(doc.key, pending);
    return pending;
  }

  async migrateReadingOrder(doc) {
    if (!this.reorder || !doc.source?.blocks?.length || doc.readingOrderVersion >= READING_ORDER_VERSION) return false;
    if (await fingerprint(doc.pdfPath) !== doc.fingerprint) throw new Error('PDF 指纹已变化，未改动原有缓存。');
    const plan = await this.reorder({pdf:doc.pdfPath,blocks:clone(doc.source.blocks),signal:this.extractionController.signal});
    const source = new Map(doc.source.blocks.map(block=>[block.id,block]));
    const ids = plan?.ids;
    if (plan?.version !== READING_ORDER_VERSION || !Array.isArray(ids) || ids.length !== source.size
        || source.size !== doc.source.blocks.length || new Set(ids).size !== ids.length || ids.some(id=>!source.has(id))) {
      throw new Error('段落标识不完整，未改动原有缓存。');
    }
    if (ids.some((id,i)=>i && source.get(id).page < source.get(ids[i-1]).page)) throw new Error('页码顺序异常，未改动原有缓存。');
    const reading = new Map((doc.reading?.blocks || []).map(block=>[block.id,block]));
    if (reading.size !== (doc.reading?.blocks.length || 0) || [...reading.keys()].some(id=>!source.has(id))) throw new Error('译文与来源标识不匹配，未改动原有缓存。');
    const backup = path.join(doc.directory,'migrations',`reading-order-v${READING_ORDER_VERSION}`);
    await mkdir(backup,{recursive:true});
    for (const name of ['document.json','source_map.json']) {
      const target = path.join(backup,name);
      try { await access(target); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await copyFile(path.join(doc.directory,name),target); } catch (error) { if (error.code !== 'ENOENT' || name === 'document.json') throw error; }
      }
    }
    const oldHash = layoutContentHash(doc.reading?.blocks?.length ? doc.reading.blocks : doc.source.blocks);
    // Keep IDs, strings, coordinates, annotations and guide references intact.
    doc.source.blocks = ids.map((id,order)=>({...source.get(id),order}));
    if (doc.reading) doc.reading.blocks = ids.flatMap((id,order)=>reading.has(id)?[{...reading.get(id),order}]:[]);
    doc.readingOrderVersion = READING_ORDER_VERSION; delete doc.readingOrderError;
    // Reordering does not change glyph geometry. Reuse a verified local layout
    // instead of extracting fonts and character positions again.
    const layoutFile = path.join(doc.directory, `layout-v${LAYOUT_VERSION}.json`);
    try {
      const layout = JSON.parse(await readFile(layoutFile,'utf8'));
      if (layout.status === 'ready' && layout.fingerprint === doc.fingerprint && layout.contentHash === oldHash
          && layout.version === LAYOUT_VERSION && layout.mappingVersion === LAYOUT_MAPPING_VERSION) {
        layout.contentHash = layoutContentHash(doc.reading?.blocks?.length ? doc.reading.blocks : doc.source.blocks);
        layout.revision = `${layout.contentHash}:mapping-${LAYOUT_MAPPING_VERSION}`;
        await copyFile(layoutFile, path.join(backup, `layout-v${LAYOUT_VERSION}.json`));
        await writeFile(layoutFile+'.tmp',JSON.stringify(layout),'utf8');await rename(layoutFile+'.tmp',layoutFile);
        this.layouts.set(doc.key,layout);
        if (doc.reading) doc.reading.flow = readingFlow(doc.reading.blocks,doc.paper.title,doc.paper.authors,layout);
      }
    } catch (error) { if (error.code !== 'ENOENT') this.log(error); }
    if (doc.reading) await this.checkpointReading(doc); else await this.save(doc);
    return true;
  }

  get(key) {
    const doc = this.documents.get(key);
    if (!doc) throw Object.assign(new Error('文献尚未打开，请重新选择文献。'), { statusCode: 404 });
    return doc;
  }

  snapshot(key) {
    const doc = this.get(key);
    return clone({ key: doc.key, paper: doc.paper, attachmentKey: doc.attachmentKey, fingerprint: doc.fingerprint,
      revision: doc.revision, reading: doc.reading || null, chat: doc.chat, layout: this.layouts.get(key) || null, readingOrderError: doc.readingOrderError || '',
      busyChat: this.jobs.has(`${key}:chat`), busyReading: this.jobs.has(`${key}:reading`) });
  }

  async open({ paper, pdfPath, attachmentKey }) {
    const paperId = paperIdentity(paper);
    if (!/^[A-Z0-9]{8}$/.test(attachmentKey)) throw new Error('缺少有效的 PDF 附件标识。');
    const file = path.resolve(String(pdfPath || ''));
    const info = await stat(file);
    if (!info.isFile() || !/\.pdf$/i.test(file)) throw new Error('请选择已下载到本机的 PDF 附件。');
    const hash = await fingerprint(file);
    const key = `${paper.libraryID}-${paper.itemKey}-${attachmentKey}-${hash.slice(0, 16)}`;
    if (this.opening.has(key)) return this.opening.get(key);
    const pending = this.openDocument({ key, paperId, paper, attachmentKey, hash, file }).finally(() => this.opening.delete(key));
    this.opening.set(key, pending);
    return pending;
  }

  async openDocument({ key, paperId, paper, attachmentKey, hash, file }) {
    let doc = this.documents.get(key);
    if (!doc) {
      const directory = path.join(this.workRoot, key);
      await mkdir(directory, { recursive: true });
      await copyFile(file, path.join(directory, 'source.pdf'));
      doc = { version: 1, key, paperId, paper: clone(paper), attachmentKey, fingerprint: hash, directory,
        pdfPath: path.join(directory, 'source.pdf'), sessions: {}, reading: null, source: null, chat: [], revision: 0 };
      this.documents.set(key, doc);
      await this.save(doc);
    } else if (JSON.stringify(doc.paper) !== JSON.stringify(paper)) { doc.paper = clone(paper); await this.save(doc); }
    await this.migrateReadingOrder(doc);
    this.ensureLayout(doc);
    return this.snapshot(key);
  }

  ensureLayout(doc, { retry = false } = {}) {
    if (!this.enrichLayout || this.closed || this.layoutJobs.has(doc.key)) return;
    const blocks = doc.reading?.blocks?.length ? doc.reading.blocks : doc.source?.blocks;
    if (!blocks?.length) return;
    const contentHash = layoutContentHash(blocks), current = this.layouts.get(doc.key);
    if (current?.version === LAYOUT_VERSION && current.mappingVersion === LAYOUT_MAPPING_VERSION && current.fingerprint === doc.fingerprint && current.contentHash === contentHash
      && !retry && (current.status === 'ready' || current.status === 'error')) return;
    const base = { version: LAYOUT_VERSION, mappingVersion: LAYOUT_MAPPING_VERSION, fingerprint: doc.fingerprint, contentHash, revision: `${contentHash}:mapping-${LAYOUT_MAPPING_VERSION}`,
      coordinateSystem: 'pdf-unrotated-bottom-left', pages: {}, blocks: {}, fonts: [], warnings: [] };
    this.layouts.set(doc.key, { ...base, status: 'pending' });
    const cacheFile = path.join(doc.directory, `layout-v${LAYOUT_VERSION}.json`);
    const saveCache = async layout => {
      await writeFile(cacheFile + '.tmp', JSON.stringify(layout), 'utf8');
      await rename(cacheFile + '.tmp', cacheFile);
    };
    const promise = (async () => {
      // Preserve canonical content. Publish logical paragraph references with a
      // reading revision so both the reader and archive receive this upgrade.
      await this.save(doc);
      if (!retry) {
        try {
          const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
          if (cached.version === LAYOUT_VERSION && cached.mappingVersion === LAYOUT_MAPPING_VERSION && cached.fingerprint === doc.fingerprint && cached.contentHash === contentHash) {
            if (['ready', 'error'].includes(cached.status)) {
              this.layouts.set(doc.key, cached); await this.updateReadingFlow(doc,cached); await this.save(doc); return;
            }
            if (cached.status === 'pending') throw new Error('上次 PDF 版式提取已中断；可以单独重试版式提取。');
          }
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      }
      await saveCache(this.layouts.get(doc.key));
      const result = await this.enrichLayout({ pdf: doc.pdfPath, directory: doc.directory, fingerprint: doc.fingerprint,
        contentHash, blocks: clone(blocks), signal: this.extractionController.signal });
      if (result?.version !== LAYOUT_VERSION || result.mappingVersion !== LAYOUT_MAPPING_VERSION || result.status !== 'ready' || result.fingerprint !== doc.fingerprint
        || result.contentHash !== contentHash || !result.blocks || !result.pages || !Array.isArray(result.fonts)) {
        throw new Error('PDF 版式缓存与当前原文不匹配。');
      }
      this.layouts.set(doc.key, result); await saveCache(result); await this.updateReadingFlow(doc,result); await this.save(doc);
    })().catch(async error => {
      const failed = { ...base, status: 'error', error: String(error.message || error), retryable: true };
      this.layouts.set(doc.key, failed);
      await saveCache(failed).catch(this.log);
      await this.save(doc).catch(this.log);
      this.log(error);
    }).finally(() => this.layoutJobs.delete(doc.key));
    this.layoutJobs.set(doc.key, promise);
  }

  retryLayout(key) {
    const doc = this.get(key);
    this.ensureLayout(doc, { retry: true });
    return this.snapshot(key);
  }

  async updateReadingFlow(doc, layout = this.layouts.get(doc.key)) {
    if (!doc.reading?.blocks?.length || layout?.status !== 'ready') return;
    const flow = readingFlow(doc.reading.blocks,doc.paper.title,doc.paper.authors,layout);
    if (JSON.stringify(flow) !== JSON.stringify(doc.reading.flow)) {
      doc.reading.flow = flow; await this.checkpointReading(doc);
    }
  }

  async source(doc, signal) {
    if (doc.source) { await this.migrateReadingOrder(doc); this.ensureLayout(doc); return doc.source; }
    if (!this.extractions.has(doc.key)) {
      const pending = this.extract(doc.pdfPath, doc.directory, this.extractionController.signal).then(async result => {
        if (!Array.isArray(result.blocks) || !result.blocks.some(block => block.original?.trim())) throw new Error('PDF 没有可用文本层，需先进行 OCR。');
        doc.source = result;
        doc.readingOrderVersion = READING_ORDER_VERSION;
        await this.save(doc);
        this.ensureLayout(doc);
        return result;
      }).finally(() => this.extractions.delete(doc.key));
      this.extractions.set(doc.key, pending);
    }
    return this.extractions.get(doc.key);
  }

  async checkpointReading(doc) {
    const previous = this.readingSaves.get(doc.key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.writeReadingCheckpoint(doc));
    this.readingSaves.set(doc.key, pending);
    return pending;
  }

  async writeReadingCheckpoint(doc) {
    doc.reading.revision++;
    doc.reading.updatedAt = Date.now();
    doc.reading.doneBlocks = doc.reading.blocks.filter(block => block.status === 'complete').length;
    const sourceMap = { paper: { ...doc.paper, source_type: 'pdf', source_path: doc.pdfPath },
      blocks: doc.reading.blocks.map(block => ({ ...block, original_text: block.original })),
      flow: doc.reading.flow,
      glossary: doc.reading.guide?.glossary || [], notes: doc.reading.notes || [], fingerprint: doc.fingerprint,
      status: doc.reading.status, updatedAt: doc.reading.updatedAt };
    const mapPath = path.join(doc.directory, 'source_map.json');
    await writeFile(mapPath + '.tmp', JSON.stringify(sourceMap, null, 2), 'utf8');
    await rename(mapPath + '.tmp', mapPath);
    doc.reading.sourceMapPath = mapPath;
    await this.save(doc);
  }

  startReading(key) {
    const doc = this.get(key), jobKey = `${key}:reading`;
    if (this.jobs.has(jobKey)) return this.snapshot(key);
    if (doc.reading?.status === 'complete' && !doc.reading.blocks.some(b => b.asset && ['figure', 'table'].includes(b.type) && b.readingNote?.status !== 'complete')) return this.snapshot(key);
    const controller = new AbortController();
    const promise = this.generate(doc, controller.signal).catch(error => this.log(error)).finally(async () => { this.jobs.delete(jobKey); await this.save(doc); });
    this.jobs.set(jobKey, { controller, promise });
    return this.snapshot(key);
  }

  async generate(doc, signal) {
    doc.reading ||= { id: `${doc.attachmentKey}:${doc.fingerprint}`, attachmentKey: doc.attachmentKey,
      fingerprint: doc.fingerprint, title: doc.paper.title, status: 'extracting', revision: 0,
      totalBlocks: 0, doneBlocks: 0, blocks: [], guide: null, assets: [], notes: [], error: '', updatedAt: Date.now() };
    const reading = doc.reading;
    reading.error = ''; reading.status = reading.blocks.length ? 'translating' : 'extracting';
    try {
      await this.checkpointReading(doc);
      const source = await this.source(doc, signal);
      signal.throwIfAborted();
      if (!reading.blocks.length) {
        reading.blocks = clone(source.blocks).map(block => ({ ...block, translation: block.translation || '',
          status: !block.original?.trim() || ['figure', 'table', 'equation'].includes(block.type) ? 'complete' : 'pending' }));
        reading.assets = clone(source.assets || []); reading.notes = clone(source.notes || []); reading.totalBlocks = reading.blocks.length;
      }
      reading.status = 'translating';
      await this.checkpointReading(doc);
      await this.layoutJobs.get(doc.key);
      await this.updateReadingFlow(doc);
      const paragraphById = new Map((reading.flow?.paragraphs || []).flatMap(ids => ids.map(id => [id,ids])));
      for (const batch of translationBatches(reading.blocks,6000,reading.flow?.paragraphs)) {
        signal.throwIfAborted();
        const input = batch.map(block => ({ id: block.id, page: block.page, type: block.type, original: block.original,
          paragraphIds: paragraphById.get(block.id) || [block.id] }));
        const context = [...new Set(batch.map(b=>paragraphById.get(b.id)).filter(Boolean))].map(ids => ({ids,
          original: ids.map(id => reading.blocks.find(b=>b.id===id).original).join(' ')}));
        const prompt = `使用已加载的 nature-reader 规范翻译这篇文献《${doc.paper.title}》的以下来源块。块 ID 是 PDF 物理定位片段，不代表完整段落；paragraphIds 相同的块属于一个连续段落，请结合给出的完整段落上下文翻译，各块只翻译自身原文，不重复相邻内容。不得添加“本段承接”“分栏截断”“下接 Sxxx”等版式说明或补写省略号。全文由程序分批处理，本轮只返回本批译文，不生成摘要或文件。逐项保留 id 与事实、术语、引用及数字。图注完整翻译，数学公式不得改写或猜测；不确定内容显式注明。不要使用工具、不要输出解释或代码围栏。只输出 JSON：{"blocks":[{"id":"S001","translation":"中文译文"}]}。每个输入 id 恰好出现一次。\n\n${JSON.stringify({blocks:input,paragraphContext:context})}`;
        let parsed;
        for (let attempt = 0; attempt < 2; attempt++) {
          const text = await this.model.run({ doc, kind: 'reading', prompt: prompt + (attempt ? '\n上轮格式不完整，请严格返回上述 JSON，完整包含每个 id。' : ''), signal });
          try {
            parsed = parseJSON(text);
            if (!Array.isArray(parsed.blocks) || parsed.blocks.length !== batch.length || new Set(parsed.blocks.map(row => row.id)).size !== batch.length
              || batch.some(block => !parsed.blocks.some(row => row.id === block.id && typeof row.translation === 'string' && row.translation.trim()))) throw new Error('译文缺少段落或包含重复段落。');
            break;
          } catch (error) { if (attempt) throw error; }
        }
        for (const block of batch) { block.translation = parsed.blocks.find(row => row.id === block.id).translation; block.status = 'complete'; }
        await this.checkpointReading(doc);
      }
      signal.throwIfAborted();
      if (!reading.guide) {
        const material = reading.blocks.filter(block => block.original).map(block => `[${block.id} p.${block.page}] ${block.original}`).join('\n\n');
        const prompt = `按照 nature-reader 为文献《${doc.paper.title}》生成中文精读指南。依据下面的来源块，不补写无依据的结论。给出阅读顺序、研究目标、方法、主要结果、局限与术语。重点卡片必须引用一个真实 blockId，original 必须是该块中的连续原句，translation 为该句中文；explanation 是阅读提示。只返回 JSON：{"overview":"...","readingOrder":["..."],"highlights":[{"category":"研究目标|研究方法|主要结果|结论|局限","blockId":"S001","original":"原句","translation":"译文","explanation":"..."}],"glossary":[{"term":"...","translation":"...","note":"..."}]}。不调用工具，不输出围栏。\n\n${material}`;
        const reply = doc.guideDraft || await this.model.run({ doc, kind: 'reading', prompt, signal });
        doc.guideDraft = reply; await this.save(doc);
        const guide = parseJSON(reply);
        if (typeof guide.overview !== 'string' || !Array.isArray(guide.highlights)) throw new Error('精读指南格式不完整，全文译文已保存，可继续生成。');
        guide.highlights = guide.highlights.filter(row => row && typeof row.category === 'string' && typeof row.translation === 'string'
          && (row.explanation === undefined || typeof row.explanation === 'string')
          && reading.blocks.some(block => block.id === row.blockId && typeof row.original === 'string' && row.original.trim() && block.original.includes(row.original)));
        reading.guide = { overview: guide.overview, readingOrder: (guide.readingOrder || []).filter(row => typeof row === 'string'),
          highlights: guide.highlights, glossary: (guide.glossary || []).filter(row => row && typeof row.term === 'string' && typeof row.translation === 'string'
            && (row.note === undefined || typeof row.note === 'string')) };
      }
      signal.throwIfAborted();
      for (const block of reading.blocks.filter(b => b.asset && ['figure', 'table'].includes(b.type))) {
        if (block.readingNote?.status === 'complete') continue;
        signal.throwIfAborted();
        const material = this.figureMaterial(doc, block);
        let mode = 'caption';
        const text = await this.model.run({ doc, kind: 'reading', prompt: this.figurePrompt(doc, block, material.context),
          images: material.images, signal, onInputMode: value => { mode = value; } });
        if (!text?.trim()) throw new Error('图表解读未返回内容，可继续生成；已有译文已保存。');
        block.readingNote = { status: 'complete', text, mode, updatedAt: Date.now() };
        await this.checkpointReading(doc);
      }
      reading.status = source.incomplete ? 'interrupted' : 'complete';
      reading.error = source.incomplete ? `部分页面需要 OCR（${(source.ocrPages || []).join('、')} 页）；可提取部分已保存，完成 OCR 后请重新打开该 PDF。` : '';
      await this.checkpointReading(doc);
    } catch (error) {
      if (!reading.guide && doc.guideDraft) { doc.rejectedGuideDraft = doc.guideDraft; delete doc.guideDraft; }
      reading.status = signal.aborted ? 'interrupted' : 'error';
      reading.error = signal.aborted ? '精读已暂停，已完成内容已保存。' : String(error.message || error);
      await this.checkpointReading(doc);
    }
  }

  figureMaterial(doc, block) {
    const asset = doc.reading.assets.find(asset => asset.name === block.asset);
    if (!asset) throw new Error('图表图片未登记，请重新打开文献后重试。');
    const relative = path.relative(doc.directory, asset.sourcePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图表图片不在本篇缓存中。');
    const captions = (block.captionIds || []).map(id => doc.reading.blocks.find(b => b.id === id)).filter(Boolean);
    const material = doc.reading.blocks.filter(b => b.original);
    return { images: [{ sourcePath: asset.sourcePath, mediaType: 'image/png' }],
      context: `当前图表：[${block.id} p.${block.page}]\n图注：\n` + captions.map(b => `[${b.id} p.${b.page}] ${b.original}\n${b.translation}`).join('\n\n')
        + '\n\n正文材料：\n' + material.map(b => `[${b.id} p.${b.page}] ${b.original}`).join('\n\n').slice(0, 120000) };
  }

  figurePrompt(doc, block, context) {
    return `为这张图表生成 Nature 精读阅读提示，文献《${doc.paper.title}》，来源 [${block.id} p.${block.page}]。用中文约 300–500 字说明：研究问题、各分面/坐标/图例的阅读顺序、主要结果、与正文结论的关系、不能据此得出的结论。表格说明行列和关键比较。引用真实图注和正文块 ID，不虚构数值；看不清或原文未说明的内容明确标注。使用简洁 Markdown，不生成 JSON 或文件，不调用工具。\n\n${context}`;
  }

  async ask(key, { id = randomUUID(), question, selection = null, retry = false }) {
    const doc = this.get(key), jobKey = `${key}:chat`;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('对话 ID 无效。');
    const existing = doc.chat.find(record => record.id === id);
    selection = existing?.selection || selection;
    if (existing && (!retry || !['error', 'interrupted'].includes(existing.status))) return this.snapshot(key);
    if (this.jobs.has(jobKey)) throw Object.assign(new Error('本篇上一条回答尚未结束，可先停止回答。'), { statusCode: 409 });
    question = String(question || '').trim();
    if (selection?.kind === 'figure') {
      const figure = doc.reading?.blocks.find(b => b.id === selection.blockId && b.asset);
      if (!figure) throw new Error('请先选择本篇已提取的图片。');
      const label = `[${figure.id} p.${figure.page}] `;
      if (!question.startsWith(label)) question = label + question;
    }
    if (!question || question.length > 30000) throw new Error('请输入不超过 30000 字的问题。');
    const record = existing || { source: 'dsh', id, question, answer: '', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() };
    if (existing) Object.assign(record, { question, status: 'pending', error: '', updatedAt: Date.now() });
    else doc.chat.push(record);
    record.selection = selection ? clone(selection) : null;
    const controller = new AbortController();
    this.jobs.set(jobKey, { controller, promise: Promise.resolve() });
    try { await this.save(doc); }
    catch (error) { this.jobs.delete(jobKey); throw error; }
    const promise = this.answer(doc, record, selection, controller.signal).catch(error => this.log(error)).finally(async () => { this.jobs.delete(jobKey); await this.save(doc); });
    this.jobs.set(jobKey, { controller, promise });
    return this.snapshot(key);
  }

  async answer(doc, record, selection, signal) {
    let lastSave = 0;
    try {
      const source = await this.source(doc, signal);
      signal.throwIfAborted();
      const blocks = doc.reading?.blocks?.length ? doc.reading.blocks : source.blocks;
      const selected = selection?.blockId ? blocks.find(block => block.id === selection.blockId) : null;
      const figure = selection?.kind === 'figure' ? selected : null;
      if (selection?.kind === 'figure' && (!figure?.asset || !['figure', 'table', 'equation'].includes(figure.type))) throw new Error('本篇图表定位已失效，请重新选择图片。');
      const material = figure ? this.figureMaterial(doc, figure) : null;
      let context = blocks.filter(block => block.original).map(block => `[${block.id} p.${block.page}] ${block.original}`).join('\n\n');
      if (context.length > 120000) {
        const words = record.question.toLowerCase().match(/[a-z]{3,}/g) || [];
        const ranked = blocks.map((block, index) => ({ block, score: words.reduce((score, word) => score + (String(block.original).toLowerCase().includes(word) ? 1 : 0), 0) + (block.id === selected?.id ? 100 : 0) + (index < 10 ? 1 : 0) }))
          .sort((a, b) => b.score - a.score).slice(0, 100).sort((a, b) => a.block.order - b.block.order);
        context = '以下为按问题检索的原文片段，并非全文；证据不足时明确说明。\n' + ranked.map(({ block }) => `[${block.id} p.${block.page}] ${block.original}`).join('\n\n').slice(0, 120000);
      }
      const selectionText = selection?.text ? String(selection.text).slice(0, 15000) : '';
      let generatedContext='';
      if(selection?.origin==='reading-note')generatedContext=figure?.readingNote?.text||'';
      else if(selection?.origin==='conversation'){
        const prior=doc.chat.find(r=>r.id===selection.recordId&&r.id!==record.id);
        if(!prior)throw new Error('引用的对话不属于当前文献，请重新选中。');
        generatedContext=selection.recordRole==='user'?prior.question:prior.answer;
      }
      const contextNotice=generatedContext?`\n选段上下文（来自先前的提问或 AI 解读，并非论文原文；可能有误，须对照原文核实）：\n${generatedContext.slice(0,30000)}\n`:'';
      const prompt = figure && selection.figureNote ? this.figurePrompt(doc, figure, material.context)
        : `你是这篇文献的阅读导师，使用 Nature 精读规范，中文回答。明确区分论文事实、推论与外部背景。每个论文相关要点尽量附上 [S001 p.1] 形式的真实来源。不要编造段落编号。${figure ? '本轮图像是否可见由下方图像输入状态确定。' : '当前只提供图注和文字，不能声称看到了图片中的细节。'}\n文献：${doc.paper.title}\n${selected ? `选中来源：[${selected.id} p.${selected.page}]\n` : ''}${selectionText ? '用户选中的文本：\n' + selectionText + '\n' : ''}${contextNotice}\n原文材料：\n${material?.context || context}\n\n用户问题：${record.question}`;
      record.status = 'streaming'; record.updatedAt = Date.now(); await this.save(doc);
      const basis = () => figure && record.imageMode === 'caption' ? '**仅依据图注与正文：当前模型未接收实际图像。**\n\n' : '';
      const answer = await this.model.run({ doc, kind: 'chat', prompt, images: material?.images || [], signal,
        onInputMode: mode => { record.imageMode = mode; }, onText: text => {
        record.answer = basis() + text; record.updatedAt = Date.now();
        if (Date.now() - lastSave > 1000) { lastSave = Date.now(); void this.save(doc).catch(error => this.log(error)); }
      } });
      signal.throwIfAborted();
      if (!answer?.trim()) throw new Error('Harness 未返回可用回答。');
      record.answer = basis() + answer; record.status = 'complete'; record.error = '';
      if (figure && selection.figureNote) {
        figure.readingNote = { status: 'complete', text: answer, mode: record.imageMode || 'caption', recordId: record.id, updatedAt: Date.now() };
        await this.checkpointReading(doc);
      }
    } catch (error) {
      record.status = signal.aborted ? 'interrupted' : 'error';
      record.error = signal.aborted ? '回答已停止，已生成内容保留。' : String(error.message || error);
    }
    record.updatedAt = Date.now(); await this.save(doc);
  }

  cancel(key, kind) {
    const job = this.jobs.get(`${key}:${kind}`);
    if (job) job.controller.abort(new Error('用户停止生成。'));
    return this.snapshot(key);
  }

  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error('DSH 插件正在关闭。'));
    this.extractionController.abort(new Error('DSH 插件正在关闭。'));
    await Promise.allSettled(this.opening.values());
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
    await Promise.allSettled(this.layoutJobs.values());
    await Promise.allSettled(this.saves.values());
    await this.model.close?.();
  }
}
