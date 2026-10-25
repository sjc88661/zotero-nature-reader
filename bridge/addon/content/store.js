(function (root) {
  "use strict";
  const Core = typeof module !== "undefined" && module.exports ? require("./core.js") : root.ZOBCore;

  class Store {
    constructor(host) {
      this.host = host;
      this.state = { version: 1, records: {}, notes: {}, summaries: {}, annotations: {}, readings: {} };
      this.tail = Promise.resolve();
      this.ready = this.initialize();
    }

    async initialize() {
      if (await this.host.io.exists(this.host.statePath)) {
        const state = JSON.parse(await this.host.io.read(this.host.statePath));
        if (state.version !== 1 || !state.records || !state.notes || !state.summaries) throw new Error("连接插件状态文件格式不兼容，已保留文件并暂停归档。");
        this.state = state;
        this.state.annotations ||= {};
        this.state.readings ||= {};
      }
      // Reformat cached full texts once through the normal serialized writer.
      // Offline vaults keep the dirty flag and retry; no generation is requested.
      if ((this.state.metadataLayoutVersion || 0) < 3) {
        for (const [identity, readings] of Object.entries(this.state.readings)) {
          if (Object.keys(readings).length && this.state.notes[identity]) this.state.notes[identity].dirty = true;
        }
        this.state.metadataLayoutVersion = 3;
      }
    }

    run(work) {
      const result = this.tail.then(() => this.ready).then(work);
      this.tail = result.catch(() => {});
      return result;
    }

    save() { return this.host.io.write(this.host.statePath, JSON.stringify(this.state, null, 2)); }

    recordsFor(identity) { return Object.values(this.state.records).filter(record => record.paperId === identity); }

    readingsFor(identity) { return Object.values(this.state.readings[identity] || {}); }

    rememberPaper(paper) {
      const identity = Core.paperId(paper);
      const existing = this.state.notes[identity] || { relativePath: null };
      this.state.notes[identity] = { ...existing, paper: { ...paper }, dirty: true };
      return identity;
    }

    async captureInner(raw, paper) {
      const record = Core.normalizeRecord(raw);
      if (!record.answer.trim()) return;
      const existing = this.state.records[record.id];
      // Retries and historical re-imports retain their first explicit paper assignment.
      const identity = existing?.paperId || (paper ? this.rememberPaper(paper) : null);
      if (identity && paper && Core.paperId(paper) === identity) this.rememberPaper(paper);
      if (identity) this.state.notes[identity].dirty = true;
      this.state.records[record.id] = { ...record, createdAt: existing?.createdAt || record.createdAt, paperId: identity };
      await this.save();
      if (identity) await this.trySync(identity);
    }

    capture(raw, paper) { return this.run(() => this.captureInner(raw, paper)); }

    archiveResult(identity, target = null, error = "") {
      const note = this.state.notes[identity];
      return { synced: !!target, relativePath: target?.relativePath || note?.relativePath || null, error: String(error || note?.lastError || "") };
    }

    async syncArchive(identity) {
      const target = await this.trySync(identity);
      return this.archiveResult(identity, target);
    }

    archiveExternal(paper, raw) {
      return this.run(async () => {
        let identity;
        try {
          identity = Core.paperId(paper);
          const record = Core.normalizeExternalRecord(raw);
          const existing = this.state.records[record.id];
          identity = existing?.paperId || identity;
          // Each backend UUID keeps its first paper assignment, even after the reader switches papers.
          if (existing && record.updatedAt < existing.updatedAt) return await this.syncArchive(identity);
          if (Core.paperId(paper) === identity) this.rememberPaper(paper);
          this.state.notes[identity].dirty = true;
          this.state.records[record.id] = { ...record, question: record.question || existing?.question || "", createdAt: existing?.createdAt ?? record.createdAt, paperId: identity };
          await this.save();
          return await this.syncArchive(identity);
        } catch (error) { return this.archiveResult(identity, null, error.message || error); }
      });
    }

    archiveReading(paper, raw) {
      return this.run(async () => {
        let identity;
        try {
          identity = Core.paperId(paper);
          const reading = Core.normalizeReading(raw);
          const existing = this.state.readings[identity]?.[reading.id];
          if (existing && (reading.revision < existing.revision || (reading.revision === existing.revision && reading.updatedAt < existing.updatedAt))) {
            return this.archiveResult(identity, null, "已拒绝过期的精读快照；较新的修订已保留。");
          }
          this.rememberPaper(paper);
          (this.state.readings[identity] ||= {})[reading.id] = reading;
          await this.save();
          return await this.syncArchive(identity);
        } catch (error) { return this.archiveResult(identity, null, error.message || error); }
      });
    }

    readingSnapshot(paper, readingId) {
      return this.run(() => structuredClone(this.state.readings[Core.paperId(paper)]?.[readingId] || null));
    }

    setAnnotations(paper, annotations) {
      return this.run(async () => {
        const identity = Core.paperId(paper);
        const previous = this.state.notes[identity];
        if (!previous && !annotations.length) return { count: 0, target: null };
        if (previous && !previous.dirty && JSON.stringify(this.state.annotations[identity]) === JSON.stringify(annotations)
          && JSON.stringify(previous.paper) === JSON.stringify(paper)) return { count: annotations.length, target: null };
        this.rememberPaper(paper);
        this.state.annotations[identity] = structuredClone(annotations);
        await this.save();
        const target = await this.trySync(identity);
        return { count: annotations.length, target };
      });
    }

    async validateVault() {
      const settings = this.host.settings();
      const folder = Core.relativeFolder(settings.folder);
      if (!settings.vaultPath || !await this.host.io.exists(this.host.join(settings.vaultPath, ".obsidian"))) throw new Error("Obsidian 库当前不可用；记录已保存在本地待同步。请检查库目录。");
      await this.host.io.mkdir(this.host.join(settings.vaultPath, ...folder.split("/")));
      return { ...settings, folder };
    }

    async locate(identity, settings) {
      const note = this.state.notes[identity];
      if (note.relativePath) {
        const path = this.host.join(settings.vaultPath, ...note.relativePath.split("/"));
        if (await this.host.io.exists(path)) return { path, relativePath: note.relativePath };
      }
      const matches = await this.host.io.findNotes(settings.vaultPath, identity);
      if (matches.length > 1) throw new Error("库中存在多篇具有同一文献标识的笔记，请保留一篇后再同步。");
      const relativePath = matches[0] || `${settings.folder}/${Core.filename(note.paper)}`;
      return { path: this.host.join(settings.vaultPath, ...relativePath.split("/")), relativePath };
    }

    async sync(identity) {
      // A failed initial state write can leave the latest queue only in memory.
      await this.save();
      const settings = await this.validateVault();
      const note = this.state.notes[identity];
      const target = await this.locate(identity, settings);
      const annotations = this.state.annotations[identity]?.map(annotation => ({ ...annotation })) ?? null;
      for (const annotation of annotations || []) {
        if (!annotation.imageSource) continue;
        if (!/^[A-Z0-9]{8}$/.test(annotation.key)) throw new Error("标注缺少有效 key，已停止写入图片。");
        annotation.imagePath = `${settings.folder}/附件/${note.paper.libraryID}-${annotation.key}.png`;
        const imageTarget = this.host.join(settings.vaultPath, ...annotation.imagePath.split("/"));
        if (await this.host.io.exists(annotation.imageSource)) await this.host.io.copy(annotation.imageSource, imageTarget);
        else if (!await this.host.io.exists(imageTarget)) delete annotation.imagePath;
      }
      const readings = this.readingsFor(identity).map(reading => ({ ...reading, assetPaths: Object.create(null) }));
      for (const reading of readings) {
        const base = `${settings.folder}/附件/nature/${note.paper.libraryID}-${note.paper.itemKey}/${reading.attachmentKey}-${reading.fingerprint.slice(0, 12)}`;
        const copy = async (source, relativePath, refresh = false) => {
          const destination = this.host.join(settings.vaultPath, ...relativePath.split("/"));
          // Fingerprinted exports are retained when a new source version arrives or an asset is removed.
          const exists = await this.host.io.exists(destination);
          if (exists && !refresh) return;
          if (!await this.host.io.exists(source)) {
            if (exists) return;
            throw new Error(`精读资产当前不可用，已保留待同步：${source}`);
          }
          await this.host.io.copy(source, destination);
        };
        for (const asset of reading.assets) {
          const relativePath = `${base}/assets/${Core.relativeFolder(asset.name)}`;
          await copy(asset.sourcePath, relativePath);
          reading.assetPaths[asset.name] = relativePath;
        }
        if (reading.sourceMapPath) {
          reading.sourceMapLink = `${base}/source_map.json`;
          await copy(reading.sourceMapPath, reading.sourceMapLink, true);
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const exists = await this.host.io.exists(target.path);
        const current = exists ? await this.host.io.read(target.path) : null;
        const updated = Core.mergeNote(current, note.paper, this.recordsFor(identity), this.state.summaries[identity] || [], annotations, !note.annotationsSectionAdded, readings, !note.natureSectionAdded);
        if (updated !== current) {
          // Re-read just before the atomic replace; retry if Obsidian edited the note during rendering.
          if (exists !== await this.host.io.exists(target.path)) continue;
          if (exists && await this.host.io.read(target.path) !== current) continue;
          await this.host.io.write(target.path, updated, { createOnly: !exists });
        }
        note.relativePath = target.relativePath;
        note.annotationsSectionAdded = true;
        note.natureSectionAdded = true;
        note.dirty = false;
        note.lastError = "";
        await this.save();
        return target;
      }
      throw new Error("笔记正在被同时编辑，已保留待同步记录，稍后重试。");
    }

    async trySync(identity) {
      try { return await this.sync(identity); }
      catch (error) {
        this.state.notes[identity].dirty = true;
        this.state.notes[identity].lastError = String(error.message || error);
        await this.save();
        this.host.log(error);
        return null;
      }
    }

    open(paper) {
      return this.run(async () => {
        const identity = this.rememberPaper(paper);
        await this.save();
        return this.sync(identity);
      });
    }

    snapshot(paper) {
      return this.run(() => {
        const identity = Core.paperId(paper);
        return { identity, records: structuredClone(this.recordsFor(identity)), summaries: structuredClone(this.state.summaries[identity] || []) };
      });
    }

    addSummary(paper, content) {
      return this.run(async () => {
        const identity = this.rememberPaper(paper);
        (this.state.summaries[identity] ||= []).push({ createdAt: Date.now(), content });
        await this.save();
        return this.sync(identity);
      });
    }

    importRecords(records, paper) {
      return this.run(async () => {
        const identity = Core.paperId(paper);
        let imported = 0;
        for (const raw of records) {
          const record = Core.normalizeRecord(raw);
          const existing = this.state.records[record.id];
          if (!record.answer.trim() || existing?.paperId) continue;
          if (!imported) this.rememberPaper(paper);
          this.state.records[record.id] = { ...record, createdAt: existing?.createdAt || record.createdAt, paperId: identity };
          imported++;
        }
        if (!imported) return { imported: 0, target: null };
        await this.save();
        const target = await this.sync(identity);
        return { imported, target };
      });
    }

    pending() {
      return this.run(() => structuredClone(Object.values(this.state.records).filter(record => !record.paperId)));
    }

    retry() {
      return this.run(async () => {
        for (const [identity, note] of Object.entries(this.state.notes)) if (note.dirty) await this.trySync(identity);
      });
    }

    drain() { return this.tail; }
  }

  if (typeof module !== "undefined" && module.exports) module.exports = Store;
  else root.ZOBStore = Store;
})(globalThis);
