(function (root) {
  "use strict";
  const { Zotero, Services, IOUtils, PathUtils, ZOBCore: Core, ZOBStore: Store, ZOBAdapter: Adapter } = root;
  const PREF = "extensions.zotero.obsidianLiteratureBridge.";
  const VERSION = "0.3.7";

  class Runtime {
    constructor() {
      this.windows = new Map();
      this.views = new Map();
      this.jobs = new Map();
      this.lastError = "";
      this.stopped = false;
      this.lastRetry = 0;
      this.timerWindow = Zotero.getMainWindow();
      this.dataDirectory = PathUtils.join(Zotero.DataDirectory.dir, "obsidian-literature-bridge");
      this.statusPath = PathUtils.join(this.dataDirectory, "status.json");
      this.io = this.makeIO();
    }

    settings() {
      return {
        vaultPath: Services.prefs.getStringPref(PREF + "vaultPath", ""),
        folder: Services.prefs.getStringPref(PREF + "folder", "文献阅读")
      };
    }

    makeIO() {
      return {
        exists: path => IOUtils.exists(path),
        read: path => IOUtils.readUTF8(path),
        mkdir: path => IOUtils.makeDirectory(path, { createAncestors: true, ignoreExisting: true }),
        write: async (path, text, options = {}) => {
          await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true, ignoreExisting: true });
          const temporary = path + ".zob-tmp";
          if (options.createOnly) {
            await IOUtils.writeUTF8(temporary, text, { flush: true });
            await IOUtils.move(temporary, path, { noOverwrite: true });
          } else {
            await IOUtils.writeUTF8(path, text, { tmpPath: temporary, flush: true });
          }
        },
        copy: async (source, target) => {
          await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true, ignoreExisting: true });
          const sourceStat = await IOUtils.stat(source);
          if (await IOUtils.exists(target)) {
            const targetStat = await IOUtils.stat(target);
            if (sourceStat.size === targetStat.size && sourceStat.lastModified === targetStat.lastModified) return;
          }
          await IOUtils.copy(source, target + ".zob-tmp");
          await IOUtils.move(target + ".zob-tmp", target, { noOverwrite: false });
        },
        findNotes: async (vault, identity) => {
          const queue = [vault];
          const matches = [];
          const prefixLength = vault.replace(/[\\/]+$/, "").length + 1;
          while (queue.length) {
            for (const path of await IOUtils.getChildren(queue.pop())) {
              const name = PathUtils.filename(path);
              if (name.startsWith(".") || name === "node_modules") continue;
              const stat = await IOUtils.stat(path, { followSymlinks: false });
              if (stat.type === "directory") queue.push(path);
              else if (stat.type === "regular" && name.toLowerCase().endsWith(".md")) {
                if (Core.noteIdentity(await IOUtils.readUTF8(path)) === identity) matches.push(path.slice(prefixLength).replace(/\\/g, "/"));
              }
            }
          }
          return matches;
        }
      };
    }

    async start() {
      if (!IOUtils || !PathUtils) throw new Error("Zotero 文件 API 不可用，无法启动 Obsidian 连接插件。");
      await this.io.mkdir(this.dataDirectory);
      this.store = new Store({ io: this.io, join: (...parts) => PathUtils.join(...parts), settings: () => this.settings(), statePath: PathUtils.join(this.dataDirectory, "state.json"), log: error => this.log(error) });
      await this.store.ready;
      await this.store.save();
      try { await this.store.validateVault(); } catch (error) { this.log(error); }
      Zotero.ObsidianLiteratureBridge = this;
      this.annotations = new root.ZOBAnnotationSync(this);
      this.annotations.start();
      for (const win of Zotero.getMainWindows?.() || [Zotero.getMainWindow()]) if (win) await this.addWindow(win);
      await this.tick();
      this.interval = this.timerWindow.setInterval(() => this.tick().catch(error => this.log(error)), 1500);
      // This is a private local build. Zotero requires an HTTPS update_url even when updates are manual.
      // Reserve a loopback URL and disable this add-on's background updates; no update server is deployed.
      const { AddonManager } = root.ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      AddonManager.getAddonByID("obsidian-literature-bridge@codex.local").then(addon => {
        if (addon) addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DISABLE;
      }).catch(error => this.log(error));
    }

    log(error) {
      this.lastError = String(error?.message || error);
      Zotero.logError(new Error("[Obsidian 文献笔记] " + this.lastError));
    }

    currentPaper(win = Zotero.getMainWindow()) {
      if (!win || win.closed) return null;
      let item;
      let attachment;
      const selectedID = win.Zotero_Tabs?.selectedID;
      if (selectedID && selectedID !== "zotero-pane") {
        const reader = Zotero.Reader.getByTabID(selectedID);
        attachment = reader?._item || (reader?.itemID ? Zotero.Items.get(reader.itemID) : null);
        item = attachment?.topLevelItem;
      } else {
        const selected = win.ZoteroPane?.getSelectedItems() || [];
        if (selected.length !== 1) return null;
        item = selected[0].topLevelItem || selected[0];
        if (selected[0].isPDFAttachment?.()) attachment = selected[0];
      }
      return this.paperFromItem(item, attachment);
    }

    paperFromItem(item, attachment) {
      if (!item?.isRegularItem?.()) return null;
      if (!attachment?.isPDFAttachment?.()) attachment = (item.getAttachments() || []).map(id => Zotero.Items.get(id)).find(candidate => candidate?.isPDFAttachment?.());
      const creators = item.getCreators().filter(creator => creator.creatorTypeID === Zotero.CreatorTypes.getID("author"));
      const authors = creators.map(creator => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" "));
      const library = Zotero.Libraries.get(item.libraryID);
      const paper = {
        libraryID: item.libraryID,
        itemKey: item.key,
        title: String(item.getField("title") || "未命名文献"),
        authors,
        firstAuthor: creators[0]?.lastName || creators[0]?.name || authors[0] || "作者未知",
        year: String(item.getField("date") || "").match(/\b\d{4}\b/)?.[0] || "",
        journal: String(item.getField("publicationTitle") || ""),
        doi: String(item.getField("DOI") || ""),
        attachmentKey: attachment?.key || null,
        groupID: library?.libraryType === "group" ? (library.groupID || Zotero.Groups.getGroupIDFromLibraryID(item.libraryID)) : null
      };
      Core.paperId(paper);
      return paper;
    }

    requirePaper(win) {
      const paper = this.currentPaper(win);
      if (!paper) throw new Error("请先在 Zotero 中选中一篇文献，或打开该文献的 PDF，再执行此操作。");
      return paper;
    }

    async archiveExternal({ paper, record }) {
      const result = await this.store.archiveExternal(paper, record);
      await this.writeStatus().catch(error => this.log(error));
      return result;
    }

    async archiveReading({ paper, reading }) {
      const result = await this.store.archiveReading(paper, reading);
      await this.writeStatus().catch(error => this.log(error));
      return result;
    }

    readingSnapshot(paper, readingId) {
      return this.store.readingSnapshot(paper, readingId);
    }

    getView(win) {
      const view = win.Meet?.Global?.overlayView || win.Meet?.Global?.views || Zotero.ZoteroGPT?.data?.views;
      if (view?.container?.ownerDocument && view.container.ownerDocument !== win.document) return null;
      return view || null;
    }

    async tick() {
      if (this.stopped || this.ticking) return;
      this.ticking = true;
      try {
        for (const [view, binding] of this.views) {
          if (view.disposed || binding.win.closed || this.getView(binding.win) !== view) { binding.adapter.detach(); this.views.delete(view); }
        }
        for (const win of this.windows.keys()) {
          if (win.closed) { this.removeWindow(win); continue; }
          const view = this.getView(win);
          if (view && !this.views.has(view)) {
            try {
              const adapter = Adapter.attach(view, {
                currentPaper: () => this.currentPaper(win),
                capture: (record, paper) => this.store.capture(record, paper).then(() => {
                  const bound = this.store.state.records[Core.normalizeRecord(record).id]?.paperId;
                  if (bound) this.annotations.queue(this.store.state.notes[bound].paper);
                  return this.writeStatus();
                }),
                log: error => this.log(error)
              });
              this.views.set(view, { win, adapter });
              this.lastError = "";
            } catch (error) {
              if (this.lastError !== String(error.message || error)) this.log(error);
            }
          }
        }
        if (Date.now() - this.lastRetry > 30000) {
          this.lastRetry = Date.now();
          await this.annotations.flush();
          await this.store.retry();
        }
        await this.writeStatus();
      } finally { this.ticking = false; }
    }

    getStatus() {
      const notes = Object.values(this.store?.state.notes || {});
      const records = Object.values(this.store?.state.records || {});
      return {
        version: VERSION,
        connected: this.views.size > 0,
        settings: this.settings(),
        records: records.length,
        annotations: Object.values(this.store?.state.annotations || {}).reduce((total, rows) => total + rows.length, 0),
        pendingAnnotations: this.annotations?.pending.size || 0,
        notes: notes.length,
        unassigned: records.filter(record => !record.paperId).length,
        pendingNotes: notes.filter(note => note.dirty).length,
        lastError: notes.find(note => note.lastError)?.lastError || this.lastError
      };
    }

    async writeStatus() {
      const status = this.getStatus();
      const json = JSON.stringify(status);
      if (json === this.previousStatus) return;
      await this.io.write(this.statusPath, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
      this.previousStatus = json;
    }

    async addWindow(win) {
      if (this.windows.has(win)) return;
      const cleanups = [];
      const doc = win.document;
      const make = (tag, attributes) => {
        const node = doc.createXULElement(tag);
        for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
        return node;
      };
      const entries = [
        ["打开 / 创建文献笔记", () => this.openNote(win)],
        ["同步本篇文献标注", () => this.syncAnnotations(win)],
        ["整理本篇讨论（AI）", () => this.summarize(win)],
        ["导入历史讨论 / 待归档记录", () => this.showManager(win)],
        ["连接设置与状态", () => this.showManager(win)]
      ];
      const tools = doc.getElementById("menu_ToolsPopup") || doc.querySelector("#menu_Tools > menupopup");
      if (tools) {
        const menu = make("menu", { id: "zob-bridge-menu", label: "Obsidian 文献笔记" });
        const popup = make("menupopup");
        for (const [label, action] of entries) {
          const item = make("menuitem", { label });
          item.addEventListener("command", () => this.action(win, action));
          popup.append(item);
        }
        menu.append(popup);
        tools.append(menu);
        cleanups.push(() => menu.remove());
      }
      const itemMenu = doc.getElementById("zotero-itemmenu");
      if (itemMenu) {
        const separator = make("menuseparator");
        const item = make("menuitem", { label: "打开 Obsidian 文献笔记" });
        item.addEventListener("command", () => this.action(win, () => this.openNote(win)));
        itemMenu.append(separator, item);
        cleanups.push(() => { separator.remove(); item.remove(); });
      }
      this.windows.set(win, cleanups);
    }

    removeWindow(win) {
      for (const cleanup of this.windows.get(win) || []) try { cleanup(); } catch {}
      this.windows.delete(win);
      for (const [view, binding] of this.views) if (binding.win === win) { binding.adapter.detach(); this.views.delete(view); }
    }

    action(win, work) {
      return Promise.resolve().then(work).catch(error => {
        this.log(error);
        Services.prompt.alert(win, "Obsidian 文献笔记", String(error.message || error));
      });
    }

    async openNote(win) {
      const paper = this.requirePaper(win);
      const target = await this.store.open(paper);
      await this.annotations.sync(paper);
      this.launch(target);
      return target;
    }

    async syncAnnotations(win) {
      const paper = this.requirePaper(win);
      const target = await this.store.open(paper);
      const result = await this.annotations.sync(paper);
      const error = this.store.state.notes[Core.paperId(paper)]?.lastError;
      if (error) throw new Error(error);
      await this.writeStatus();
      this.launch(target);
      return result;
    }

    launch(target) {
      const settings = this.settings();
      Zotero.launchURL(`obsidian://open?vault=${encodeURIComponent(PathUtils.filename(settings.vaultPath.replace(/[\\/]+$/, "")))}&file=${encodeURIComponent(target.relativePath)}`);
    }

    async history(win) {
      const view = this.getView(win);
      if (view?.conversationHistoryReady) await view.conversationHistoryReady;
      const byId = new Map((await this.store.pending()).map(record => [record.id, record]));
      for (const raw of view?.conversationHistory || []) {
        const record = Core.normalizeRecord(raw);
        if (record.answer.trim() && !this.store.state.records[record.id]?.paperId) byId.set(record.id, record);
      }
      return Core.orderedRecords([...byId.values()]);
    }

    async importHistory(win, ids) {
      const paper = this.requirePaper(win);
      const chosen = new Set(ids);
      const records = (await this.history(win)).filter(record => chosen.has(record.id));
      if (!records.length) throw new Error("请先选择需要导入的历史讨论。");
      const result = await this.store.importRecords(records, paper);
      if (result.imported) this.annotations.queue(paper);
      await this.writeStatus();
      return result;
    }

    async saveSettings(vaultPath, folder) {
      folder = Core.relativeFolder(folder);
      const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
      file.initWithPath(String(vaultPath).trim());
      file.normalize();
      if (!await IOUtils.exists(PathUtils.join(file.path, ".obsidian"))) throw new Error("指定目录不是可用的 Obsidian 库，请选择包含 .obsidian 的库根目录。");
      await this.io.mkdir(PathUtils.join(file.path, ...folder.split("/")));
      Services.prefs.setStringPref(PREF + "vaultPath", file.path);
      Services.prefs.setStringPref(PREF + "folder", folder);
      this.lastError = "";
      await this.store.retry();
      await this.writeStatus();
    }

    showManager(win) {
      if (this.manager && !this.manager.closed) { this.manager.focus(); return; }
      this.manager = win.openDialog("chrome://zob-bridge/content/manager.xhtml", "zob-bridge-manager", "chrome,centerscreen,resizable,dialog=no,width=880,height=760", { bridge: this, mainWindow: win });
    }

    async summarize(win, progress = () => {}) {
      const paper = this.requirePaper(win);
      const identity = Core.paperId(paper);
      if (this.jobs.has(identity)) throw new Error("这篇文献正在整理，请等待本次完成。");
      const model = win.Meet?.OpenAI;
      if (typeof model?.getGPTResponseByOpenAI !== "function") throw new Error("请先启用 Awesome GPT，并配置可用的模型 API。");
      const snapshot = await this.store.snapshot(paper);
      if (!snapshot.records.length) throw new Error("这篇文献尚无已归档讨论；可先导入历史记录或进行一次新讨论。");
      if (this.jobs.has(identity)) throw new Error("这篇文献正在整理，请等待本次完成。");
      const job = { cancelled: false, xhr: null };
      this.jobs.set(identity, job);
      const request = async prompt => {
        if (job.cancelled || this.stopped) throw new Error("整理已取消。");
        const errors = [];
        const text = await model.getGPTResponseByOpenAI(prompt, {
          includeHistory: false, includeSidepanelHistory: false, throwOnError: true, requireCompleteResponse: true,
          retryServerErrors: false, absoluteTimeoutMs: 300000, requestTimeoutMs: 300000,
          isCancelled: () => job.cancelled || this.stopped,
          onXhr: xhr => { job.xhr = xhr; if (job.cancelled || this.stopped) xhr.abort(); },
          onApiError: error => errors.push(error)
        });
        if (job.cancelled || this.stopped) throw new Error("整理已取消。");
        if (errors.length || !String(text || "").trim()) throw new Error("模型未返回完整可用的整理稿，已有笔记已保留。请检查 Awesome GPT 的 API 配置后重试。");
        return String(text).trim();
      };
      const instructions = `你正在整理关于文献《${paper.title}》的阅读讨论。仅以所给讨论为依据，不补写未获支持的论文事实。区分对话中的解释与已确认的论文结论，无法确认的内容列为待核实。保留材料中形如 [[#^zob-...|讨论 N]] 的引用，方便回到原始记录。使用中文 Markdown，不加总的一级标题，不输出管理区注释。`;
      try {
        let parts = Core.summaryChunks(paper, snapshot.records);
        let calls = 0;
        if (parts.length > 1) {
          const summaries = [];
          for (let index = 0; index < parts.length; index++) {
            progress(`正在整理讨论片段 ${index + 1}/${parts.length}`);
            summaries.push(await request(`${instructions}\n请将此片段压缩为不超过 2000 字的事实、解释、疑问和引用，供后续合并：\n\n${parts[index]}`));
            calls++;
          }
          parts = summaries;
          for (let round = 0; parts.join("\n\n").length > 16000; round++) {
            if (round >= 8) throw new Error("讨论过长，分段整理未能收敛；已有笔记已保留。");
            const combined = parts.join("\n\n");
            const next = [];
            for (let offset = 0; offset < combined.length; offset += 16000) {
              progress("正在合并分段整理稿");
              next.push(await request(`${instructions}\n进一步压缩至不超过 2000 字，保留关键结论与原始引用：\n\n${combined.slice(offset, offset + 16000)}`));
              calls++;
            }
            parts = next;
          }
        }
        progress("正在生成文献阅读整理稿");
        const result = await request(`${instructions}\n按“主要结论”“关键解释与讨论”“待核实问题”“后续阅读与研究想法”整理。每项注明讨论来源；材料未涉及的部分说明未涉及。最后注明这是依据对话生成的整理稿。\n\n${parts.join("\n\n")}`);
        const target = await this.store.addSummary(paper, result);
        progress(`已保存整理稿（${calls + 1} 次模型请求）`);
        await this.writeStatus();
        this.launch(target);
        return target;
      } finally { this.jobs.delete(identity); }
    }

    cancelSummary(win) {
      const paper = this.requirePaper(win);
      const job = this.jobs.get(Core.paperId(paper));
      if (job) { job.cancelled = true; job.xhr?.abort(); }
    }

    async stop() {
      this.stopped = true;
      if (this.interval) this.timerWindow.clearInterval(this.interval);
      await this.annotations?.stop();
      for (const job of this.jobs.values()) { job.cancelled = true; try { job.xhr?.abort(); } catch {} }
      for (const win of [...this.windows.keys()]) this.removeWindow(win);
      if (this.manager && !this.manager.closed) this.manager.close();
      await this.store?.drain();
      if (Zotero.ObsidianLiteratureBridge === this) delete Zotero.ObsidianLiteratureBridge;
    }
  }

  root.ZOBRuntime = Runtime;
})(globalThis);
