(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const COLORS = ['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5', '#e56eee', '#f19837', '#aaaaaa'];
  const validColor = color => /^#[a-f0-9]{6}$/i.test(color || '');
  const signature = json => json ? JSON.stringify([json.type, json.text || '', json.comment || '', json.color, json.position, json.tags || []]) : null;
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  function rectsFor(layout, start = 0, end = Infinity) {
    if (!layout?.mapped) return [];
    const lines = new Map();
    for (const char of layout.chars || []) if (char.end > start && char.start < end) {
      const rect = lines.get(char.line);
      if (rect) { rect[0] = Math.min(rect[0], char.rect[0]); rect[1] = Math.min(rect[1], char.rect[1]); rect[2] = Math.max(rect[2], char.rect[2]); rect[3] = Math.max(rect[3], char.rect[3]); }
      else lines.set(char.line, [...char.rect]);
    }
    return [...lines.values()].filter(r => r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]);
  }
  function selectionParts(snapshot, selection) {
    if (snapshot?.layout?.status !== 'ready') throw new Error('文字定位正在准备；可稍后标注，或先返回原 PDF。');
    if (snapshot.layout.version !== 1 || snapshot.layout.fingerprint !== snapshot.fingerprint || snapshot.layout.coordinateSystem !== 'pdf-unrotated-bottom-left') throw new Error('定位缓存与当前 PDF 不一致，请重新打开文献。');
    if (!Array.isArray(selection?.segments) || !selection.segments.length || selection.segments.length > 100) throw new Error('请重新选择正文或译文。');
    return selection.segments.map(segment => {
      const block = snapshot.reading?.blocks.find(b => b.id === segment.blockId);
      if (!['original','translation','readingNote'].includes(segment.language)) throw new Error('选区来源无效。');
      const language = segment.language;
      const text = language === 'readingNote' ? root.ZNRText.displayText(block?.readingNote?.text) : block?.[language];
      if (!text || !Number.isInteger(segment.start) || !Number.isInteger(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.end > text.length || text.slice(segment.start, segment.end) !== segment.text) throw new Error('选区已变化，请重新选择后保存。');
      if(language==='readingNote') {
        if(!block.asset || segment.sourceText!==text)throw new Error('图表解读已变化，请重新选择后保存。');
        const crop=snapshot.layout.pages?.[String(block.page)]?.cropBox;
        if(!Array.isArray(crop)||crop.length!==4||!crop.every(Number.isFinite)||crop[2]-crop[0]<22||crop[3]-crop[1]<22)throw new Error('尚无可靠页面位置，请先返回原文。');
        const caption=(block.captionIds||[]).map(id=>rectsFor(snapshot.layout.blocks[id])[0]).find(Boolean);
        const x=Math.max(crop[0],Math.min(crop[2]-22,caption?.[0]??crop[0]+6));
        const y=Math.max(crop[1],Math.min(crop[3]-22,caption?.[1]??crop[3]-28));
        return {segment:{...segment,language},block,rects:[[x,y,x+22,y+22]],note:true};
      }
      const rects = rectsFor(snapshot.layout.blocks[block.id], language === 'original' ? segment.start : 0, language === 'original' ? segment.end : Infinity);
      if (!rects.length) throw new Error('此段尚无可靠文字坐标，请返回原 PDF 标注。');
      return { segment: { ...segment, language }, block, rects };
    });
  }
  function rangesFromRects(snapshot, position) {
    const segments = [];
    if (position?.nextPageRects?.length) segments.push(...rangesFromRects(snapshot, { pageIndex: position.pageIndex + 1, rects: position.nextPageRects }));
    for (const block of snapshot?.reading?.blocks || []) {
      if (block.page !== position?.pageIndex + 1) continue;
      const chars = snapshot.layout?.blocks?.[block.id]?.chars || [];
      const selected = chars.filter(c => position.rects?.some(r => overlap(r, c.rect) > (c.rect[2] - c.rect[0]) * (c.rect[3] - c.rect[1]) * .3));
      if (!selected.length) continue;
      selected.sort((a, b) => a.start - b.start);
      let range;
      for (const c of selected) {
        if (range && c.start <= range.end + 1) range.end = Math.max(range.end, c.end);
        else { range = { blockId: block.id, language: 'original', start: c.start, end: c.end }; segments.push(range); }
      }
    }
    return segments;
  }
  class Annotations {
    constructor(runtime) {
      this.runtime = runtime; this.file = root.PathUtils.join(runtime.directory, 'annotation-links.json');
      this.data = { version: 1, links: {}, operations: {}, undo: [] }; this.tail = Promise.resolve(); this.rows = new Map(); this.busy = false;
    }
    async start() {
      if (await root.IOUtils.exists(this.file)) this.data = JSON.parse(await root.IOUtils.readUTF8(this.file));
      await this.recover();
      this.observer = root.Zotero.Notifier.registerObserver({ notify: (_event, type, ids) => {
        if (type !== 'item' || this.busy) return;
        this.refreshSoon();
      } }, ['item'], 'nature-reader-annotations');
    }
    save() { return root.IOUtils.writeUTF8(this.file, JSON.stringify(this.data), { tmpPath: this.file + '.tmp', flush: true }); }
    refreshSoon() {
      if (this.timer) this.runtime.win.clearTimeout(this.timer);
      this.timer = this.runtime.win.setTimeout(() => { this.timer = null; this.runtime.safe(() => this.refresh()); }, 400);
    }
    serialize(work) { const result = this.tail.then(work); this.tail = result.catch(() => {}); return result; }
    async nativeSave(attachment, json) {
      // saveFromJSON uses saveTx, which cannot nest inside our multi-part transaction.
      // Use the same native annotation fields with save() under the outer transaction.
      let item = root.Zotero.Items.getByLibraryAndKey(attachment.libraryID, json.key);
      if (!item) { item = new root.Zotero.Item('annotation'); item.libraryID = attachment.libraryID; item.key = json.key; await item.loadPrimaryData(); }
      item.parentID = attachment.id; item._requireData('annotation'); item._requireData('annotationDeferred');
      item.annotationType = json.type; item.annotationAuthorName = json.authorName || '';
      item.annotationText = json.text || ''; item.annotationComment = json.comment || ''; item.annotationColor = json.color;
      item.annotationPageLabel = json.pageLabel; item.annotationSortIndex = json.sortIndex; item.annotationPosition = JSON.stringify(json.position);
      item.annotationIsExternal = !!json.isExternal; item.setTags((json.tags || []).map(t => ({ tag: t.name })));
      await item.save({ skipSelect: true }); return item;
    }
    async transaction(work, attachment, keys = []) {
      const before = copy(this.data);
      try { return await root.Zotero.DB.executeTransaction(work); }
      catch (error) {
        this.data = before;
        for (const key of keys) {
          const item = root.Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
          if (item) await item.reload(null, true).catch(failure => this.runtime.log(failure));
        }
        await attachment.reload(['childItems'], true).catch(failure => this.runtime.log(failure));
        await this.save(); this.refreshSoon(); throw error;
      }
    }
    async recover() {
      let changed = false;
      for (const [id, operation] of Object.entries(this.data.operations)) {
        if (operation.complete || !operation.entries?.length) continue;
        const items = await Promise.all(operation.entries.map(row => root.Zotero.Items.getByLibraryAndKeyAsync(operation.libraryID, row.json.key)));
        await root.Zotero.Items.loadDataTypes(items.filter(Boolean), ['annotation', 'annotationDeferred', 'tags']);
        if (items.every(Boolean)) {
          const matching = items.every((item, i) => item.parentID === operation.attachmentID && signature(root.Zotero.Annotations.toJSONSync(item)) === signature(operation.entries[i].json));
          if (matching) {
            for (const row of operation.entries) this.data.links[this.key(operation.libraryID, row.json.key)] = row.link;
            this.data.undo.push({ paperKey: operation.paperKey, before: operation.entries.map(row => ({ key: row.json.key, json: null, link: null, after: signature(row.json) })) });
          }
          operation.complete = true; changed = true;
        } else if (items.every(item => !item)) { delete this.data.operations[id]; changed = true; }
        else {
          // A native annotation was changed/deleted after the transaction committed.
          // Preserve those edits and retire this operation, never recreate missing parts.
          operation.complete = true; changed = true;
        }
      }
      if (changed) await this.save();
    }
    async attachment(binding) {
      const attachment = binding.reader._item || await root.Zotero.Items.getAsync(binding.reader.itemID);
      if (!attachment?.isPDFAttachment() || attachment.key !== binding.paper?.attachmentKey) throw new Error('当前 PDF 已切换，请重新操作。');
      return attachment;
    }
    key(libraryID, key) { return libraryID + ':' + key; }
    async refresh() {
      for (const binding of this.runtime.bindings.values()) {
        if (!binding.key || !binding.paper) continue;
        try {
          const attachment = await this.attachment(binding), snapshot = this.runtime.known.get(binding.key)?.snapshot;
          await root.Zotero.Items.loadDataTypes([attachment], ['childItems']);
          const items = await root.Zotero.Items.getAsync(attachment.getAnnotations(false, true));
          await root.Zotero.Items.loadDataTypes(items, ['annotation', 'annotationDeferred', 'tags']);
          const rows = [];
          for (const item of items) {
            if (!['highlight', 'underline', 'note'].includes(item.annotationType) || item.deleted) continue;
            const json = root.Zotero.Annotations.toJSONSync(item), key = this.key(item.libraryID, item.key);
            const stored = this.data.links[key];
            const link = stored?.paperKey === binding.key && stored.position === JSON.stringify(json.position) ? stored : null;
            if(item.annotationType==='note'&&!link)continue;
            const segments = link?.segments || rangesFromRects(snapshot, json.position);
            const prefix = link?.prefix || '';
            rows.push({ key: item.key, color: json.color, comment: json.comment || '', displayComment: prefix && (json.comment || '').startsWith(prefix) ? json.comment.slice(prefix.length) : json.comment || '',
              segments, paragraphRefs: [...new Set(segments.filter(s => s.language === 'original').map(s => s.blockId))],
              page: json.position.pageIndex + 1, operationId: link?.operationId || null, editable: attachment.isEditable() && item.isEditable() && !json.readOnly && !json.isExternal });
          }
          this.rows.set(binding.key, rows); this.runtime.emit(binding);
        } catch (error) { this.runtime.log(error); }
      }
    }
    async sync(binding) {
      binding.annotationStatus = '已保存到 Zotero · Obsidian 待同步'; this.runtime.emit(binding);
      try {
        const bridge = this.runtime.bridge();
        await bridge.annotations.sync(binding.paper);
        const note = bridge.store.state.notes[binding.paper.libraryID + ':' + binding.paper.itemKey];
        if (note?.dirty) throw new Error('笔记等待写入');
        binding.annotationStatus = '已同步到 Zotero 与 Obsidian';
      } catch { binding.annotationStatus = '已保存到 Zotero · Obsidian 待同步'; }
      await this.refresh();
    }
    async create(binding, message) {
      return this.serialize(async () => {
        const snapshot = this.runtime.known.get(binding.key)?.snapshot, attachment = await this.attachment(binding);
        if (!attachment.isEditable()) throw new Error('此文库当前为只读，无法保存标注。');
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(message.operationId || '')) throw new Error('标注操作 ID 无效。');
        const operationKey = binding.key + ':' + message.operationId;
        let operation = this.data.operations[operationKey];
        if (operation?.complete) { await this.sync(binding); return; }
        const parts = selectionParts(snapshot, message.selection);
        operation ||= { paperKey: binding.key, libraryID: attachment.libraryID, attachmentID: attachment.id, keys: parts.map(() => root.Zotero.DataObjectUtilities.generateKey()), complete: false };
        if (operation.keys.length !== parts.length) throw new Error('选区与待保存记录不一致，请重新选择。');
        operation.entries = parts.map((part, index) => {
            const { block, rects, segment } = part, key = operation.keys[index];
            const prefix = part.note ? `AI 图表解读选段（非论文原文），关联 ${block.id}，第 ${block.page} 页：\n${segment.text}\n\n`
              : segment.language === 'translation' ? '中文选段，原文按段落定位：\n' + segment.text + '\n\n' : '';
            const position = { pageIndex: block.page - 1, rects };
            const json = { key, type: part.note ? 'note' : 'highlight', color: validColor(message.color) ? message.color : COLORS[0],
              text: part.note ? '' : segment.language === 'translation' ? block.original : segment.text, comment: prefix + String(message.comment || ''),
              pageLabel: String(block.page), sortIndex: [String(block.page - 1).padStart(5, '0'), String(Math.max(0, Math.floor(block.order * 1000 + segment.start))).slice(0, 6).padStart(6, '0'), '00000'].join('|'), position };
            const link = { paperKey: binding.key, fingerprint: snapshot.fingerprint,
              segments: [copy(segment)], prefix, position: JSON.stringify(position), operationId: message.operationId };
            return { json, link };
        });
        this.data.operations[operationKey] = operation; await this.save();
        const before = operation.keys.map(key => ({ key, json: null, link: null }));
        this.busy = true;
        try {
          await this.transaction(async () => {
            for (const row of operation.entries) {
              if (!root.Zotero.Items.getByLibraryAndKey(attachment.libraryID, row.json.key)) await this.nativeSave(attachment, row.json);
              this.data.links[this.key(attachment.libraryID, row.json.key)] = row.link;
            }
          }, attachment, operation.keys);
          this.data.operations[operationKey].complete = true;
          this.pushUndo(binding, before); await this.save();
        } finally { this.busy = false; }
        await this.sync(binding);
      });
    }
    pushUndo(binding, before) {
      for (const row of before) {
        const current = root.Zotero.Items.getByLibraryAndKey(binding.paper.libraryID, row.key);
        row.after = current ? signature(root.Zotero.Annotations.toJSONSync(current)) : null;
      }
      this.data.undo.push({ paperKey: binding.key, before }); this.data.undo = this.data.undo.slice(-30);
    }
    async edit(binding, message) {
      return this.serialize(async () => {
        const attachment = await this.attachment(binding), item = root.Zotero.Items.getByLibraryAndKey(attachment.libraryID, message.key);
        if (!item || item.parentID !== attachment.id || !attachment.isEditable() || !item.isEditable() || item.annotationIsExternal) throw new Error('此标注不可编辑或已被删除。');
        await root.Zotero.Items.loadDataTypes([item], ['annotation', 'annotationDeferred', 'tags']);
        const json = root.Zotero.Annotations.toJSONSync(item); json.key = item.key;
        if (json.readOnly) throw new Error('此标注为只读，无法修改。');
        const linkKey = this.key(attachment.libraryID, item.key), link = this.data.links[linkKey];
        const before = [{ key: item.key, json: copy(json), link: link ? copy(link) : null }];
        const validLink = link?.paperKey === binding.key && link.position === JSON.stringify(json.position);
        const prefix = validLink && link.prefix && (json.comment || '').startsWith(link.prefix) ? link.prefix : '';
        this.busy = true;
        try {
          await this.transaction(async () => {
          if (message.remove) { await item.erase(); delete this.data.links[linkKey]; }
          else {
            if (validColor(message.color)) json.color = message.color;
            if (typeof message.comment === 'string') json.comment = prefix + message.comment;
            await this.nativeSave(attachment, json);
            if (!validLink) delete this.data.links[linkKey]; else link.prefix = prefix;
          }
          }, attachment, [item.key]);
          this.pushUndo(binding, before); await this.save();
        } finally { this.busy = false; }
        await this.sync(binding);
      });
    }
    async undo(binding) {
      return this.serialize(async () => {
        let index = this.data.undo.length - 1;
        while (index >= 0 && this.data.undo[index].paperKey !== binding.key) index--;
        if (index < 0) return;
        const attachment = await this.attachment(binding); if (!attachment.isEditable()) throw new Error('文库只读，无法撤销。');
        const operation = this.data.undo[index]; this.busy = true;
        try {
          await this.transaction(async () => {
          for (const row of operation.before) {
            const item = root.Zotero.Items.getByLibraryAndKey(attachment.libraryID, row.key);
            if (row.after === undefined || item && (item.parentID !== attachment.id || !item.isEditable() || root.Zotero.Annotations.toJSONSync(item).readOnly) || (item ? signature(root.Zotero.Annotations.toJSONSync(item)) : null) !== row.after) throw new Error('标注此后已在 Zotero 中修改或变为只读；为保留新修改，未撤销。');
          }
          for (const row of operation.before) {
            const item = root.Zotero.Items.getByLibraryAndKey(attachment.libraryID, row.key);
            if (row.json) await this.nativeSave(attachment, row.json);
            else if (item?.parentID === attachment.id) await item.erase();
            const key = this.key(attachment.libraryID, row.key);
            if (row.link) this.data.links[key] = row.link; else delete this.data.links[key];
          }
          }, attachment, operation.before.map(row => row.key));
          this.data.undo.splice(index, 1); await this.save();
        } finally { this.busy = false; }
        await this.sync(binding);
      });
    }
    async stop() { root.Zotero.Notifier.unregisterObserver(this.observer); if (this.timer) this.runtime.win.clearTimeout(this.timer); await this.tail; }
  }
  root.ZNRAnnotationCore = { rectsFor, rangesFromRects, selectionParts, COLORS };
  root.ZNRAnnotations = Annotations;
  if (typeof module !== 'undefined') module.exports = { rectsFor, rangesFromRects, selectionParts, COLORS, Annotations };
})(globalThis);
