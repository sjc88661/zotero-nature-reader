(function (root) {
  "use strict";
  const { Zotero, ZOBCore: Core } = root;

  class AnnotationSync {
    constructor(runtime) {
      this.runtime = runtime;
      this.pending = new Map();
      this.tail = Promise.resolve();
      this.stopped = false;
    }

    start() {
      this.observer = Zotero.Notifier.registerObserver({
        notify: (event, type, ids, extraData) => {
          // Return promptly: reading attachments and writing notes must not block Zotero's notifier.
          this.changed(event, type, ids, extraData || {}).catch(error => this.runtime.log(error));
        }
      }, ["item", "item-tag"], "obsidian-literature-annotations");
      for (const note of Object.values(this.runtime.store.state.notes)) this.queue(note.paper);
    }

    queue(paper) {
      if (this.stopped || !paper) return;
      this.pending.set(Core.paperId(paper), paper);
      if (this.timer) this.runtime.timerWindow.clearTimeout(this.timer);
      this.timer = this.runtime.timerWindow.setTimeout(() => {
        this.timer = null;
        this.flush().catch(error => this.runtime.log(error));
      }, 800);
    }

    async changed(event, type, ids, extraData) {
      if (this.stopped || !["add", "modify", "delete", "trash", "remove"].includes(event)) return;
      const state = this.runtime.store.state;
      for (const rawID of ids) {
        const id = Number(type === "item-tag" ? String(rawID).split("-")[0] : rawID);
        const old = extraData[rawID];
        // A deleted item is no longer in Zotero.Items; use the saved annotation/attachment IDs.
        for (const [identity, annotations] of Object.entries(state.annotations)) {
          if (annotations.some(annotation => annotation.itemID === id || annotation.attachmentID === id
            || (old?.libraryID === state.notes[identity]?.paper.libraryID && [annotation.key, annotation.attachmentKey].includes(old.key)))) {
            this.queue(state.notes[identity]?.paper);
          }
        }
        const item = Zotero.Items.exists(id) ? await Zotero.Items.getAsync(id) : null;
        if (!item) continue;
        let attachment;
        let parent;
        if (item.isAnnotation()) {
          attachment = item.parentID ? await Zotero.Items.getAsync(item.parentID) : null;
          parent = attachment?.parentID ? await Zotero.Items.getAsync(attachment.parentID) : null;
        } else if (item.isPDFAttachment()) {
          attachment = item;
          parent = item.parentID ? await Zotero.Items.getAsync(item.parentID) : null;
        } else if (item.isRegularItem()) parent = item;
        if (!parent?.isRegularItem() || parent.deleted) continue;
        const identity = `${parent.libraryID}:${parent.key}`;
        // A new annotation creates a note; unrelated parent metadata edits do not import a library.
        if (!item.isAnnotation() && !state.notes[identity]) continue;
        await Zotero.Items.loadDataTypes([parent], ["itemData", "creators", "childItems"]);
        this.queue(this.runtime.paperFromItem(parent, attachment));
      }
    }

    sync(paper) {
      const result = this.tail.then(() => this.collect(paper));
      this.tail = result.catch(() => {});
      return result;
    }

    async collect(paper) {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(paper.libraryID, paper.itemKey);
      if (!item || item.deleted) return this.runtime.store.setAnnotations(paper, []);
      await Zotero.Items.loadDataTypes([item], ["itemData", "creators", "childItems"]);
      const attachments = (await Zotero.Items.getAsync(item.getAttachments())).filter(attachment => attachment.isPDFAttachment() && !attachment.deleted);
      await Zotero.Items.loadDataTypes(attachments, ["itemData", "childItems"]);
      const rows = [];
      for (const attachment of attachments) {
        const annotations = await Zotero.Items.getAsync(attachment.getAnnotations(false, true));
        await Zotero.Items.loadDataTypes(annotations, ["annotation", "annotationDeferred", "tags"]);
        let renderAttempted = false;
        for (const annotation of annotations) {
          const data = Zotero.Annotations.toJSONSync(annotation);
          let imageSource = null;
          if (["image", "ink"].includes(data.type)) {
            const source = Zotero.Annotations.getCacheImagePath(annotation);
            if (!await this.runtime.io.exists(source) && !renderAttempted) {
              renderAttempted = true;
              try { await Zotero.PDFWorker.renderAttachmentAnnotations(attachment.id); }
              catch (error) { this.runtime.log(error); }
            }
            if (await this.runtime.io.exists(source)) imageSource = source;
          }
          rows.push({
            itemID: annotation.id, key: annotation.key, attachmentID: attachment.id, attachmentKey: attachment.key,
            attachmentTitle: String(attachment.getField("title") || "PDF"), type: data.type,
            text: String(data.text || ""), comment: String(data.comment || ""), color: String(data.color || ""),
            pageLabel: String(data.pageLabel || ""), pageIndex: Number.isInteger(data.position?.pageIndex) ? data.position.pageIndex : null,
            sortIndex: String(data.sortIndex || ""), tags: (data.tags || []).map(tag => tag.name),
            modified: data.dateModified, imageSource
          });
        }
      }
      rows.sort((a, b) => a.attachmentKey.localeCompare(b.attachmentKey) || a.sortIndex.localeCompare(b.sortIndex) || a.key.localeCompare(b.key));
      const current = this.runtime.paperFromItem(item, attachments.find(attachment => attachment.key === paper.attachmentKey) || attachments[0]);
      return this.runtime.store.setAnnotations(current, rows);
    }

    async flush() {
      const batch = [...this.pending];
      this.pending.clear();
      for (const [identity, paper] of batch) {
        try { await this.sync(paper); }
        catch (error) {
          this.pending.set(identity, paper);
          this.runtime.log(error);
        }
      }
      await this.runtime.writeStatus();
    }

    async stop() {
      this.stopped = true;
      Zotero.Notifier.unregisterObserver(this.observer);
      if (this.timer) this.runtime.timerWindow.clearTimeout(this.timer);
      await this.flush();
      await this.tail;
    }
  }

  root.ZOBAnnotationSync = AnnotationSync;
})(globalThis);
