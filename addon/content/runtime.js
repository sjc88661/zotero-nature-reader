(function (root) {
  'use strict';
  const { Zotero, Services, IOUtils, PathUtils, Components, ChromeUtils } = root;
  const ID = 'zotero-nature-reader@codex.local';
  const PREF = 'extensions.zotero.natureReader.';
  const clone = value => root.structuredClone(value);

  class Runtime {
    constructor() {
      this.win = Zotero.getMainWindow(); this.windows = new Map(); this.bindings = new Map(); this.known = new Map();
      this.stopped = false; this.lastError = ''; this.connected = false; this.assetCache = new Map();
      this.directory = PathUtils.join(Zotero.DataDirectory.dir, 'nature-reader');
      this.statePath = PathUtils.join(this.directory, 'state.json');
      this.statusPath = PathUtils.join(this.directory, 'status.json');
      this.saveTail = Promise.resolve();
      this.annotations = new root.ZNRAnnotations(this);
      this.readerListener = event => {
        const button = event.doc.createElement('button');
        button.textContent = 'Nature 精读'; button.title = '展开 / 收起 DSH 文献阅读助手';
        button.addEventListener('click', () => this.safe(() => this.togglePanel(event.reader)));
        event.append(button);
      };
      this.selectionListener = event => {
        const text = event.params?.annotation?.text;
        if (!text) return;
        const button = event.doc.createElement('button'); button.textContent = '问 Nature';
        button.addEventListener('click', () => this.safe(async () => {
          const binding = await this.attach(event.reader);
          if (!binding) return;
          binding.collapsed = false; this.layout(binding);
          binding.selected = { text, page: (event.params.annotation.position?.pageIndex ?? 0) + 1 };
          this.emit(binding); binding.sidebar.contentDocument?.getElementById('question')?.focus();
        }));
        event.append(button);
      };
    }

    defaultConnectionPath() {
      const env = Components.classes['@mozilla.org/process/environment;1'].getService(Components.interfaces.nsIEnvironment);
      return PathUtils.join(env.get('USERPROFILE'), '.dsh', 'zotero-nature', 'connection.json');
    }

    async start() {
      await IOUtils.makeDirectory(this.directory, { createAncestors: true, ignoreExisting: true });
      if (await IOUtils.exists(this.statePath)) {
        const state = JSON.parse(await IOUtils.readUTF8(this.statePath));
        for (const item of state.documents || []) {
          let snapshot = null;
          if (/^[A-Za-z0-9-]+$/.test(item.key)) {
            try { snapshot = JSON.parse(await IOUtils.readUTF8(PathUtils.join(this.directory, 'cache', item.key + '.json'))); } catch {}
          }
          this.known.set(item.key, { ...item, refresh: true, snapshot });
        }
      }
      await IOUtils.makeDirectory(PathUtils.join(this.directory, 'cache'), { createAncestors: true, ignoreExisting: true });
      await this.annotations.start();
      Zotero.NatureReader = this;
      Zotero.Reader.registerEventListener('renderToolbar', this.readerListener, ID);
      Zotero.Reader.registerEventListener('renderTextSelectionPopup', this.selectionListener, ID);
      for (const win of Zotero.getMainWindows?.() || [this.win]) if (win) await this.addWindow(win);
      await this.tick();
      this.interval = this.win.setInterval(() => this.tick().catch(error => this.log(error)), 1800);
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      AddonManager.getAddonByID(ID).then(addon => { if (addon) addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DISABLE; }).catch(error => this.log(error));
    }

    bridge() {
      const bridge = Zotero.ObsidianLiteratureBridge;
      if (!bridge?.archiveExternal || !bridge?.archiveReading) throw new Error('请先启用 Obsidian 文献笔记插件 0.3.0 或更新版本。');
      return bridge;
    }

    async connection() {
      const file = Services.prefs.getStringPref(PREF + 'connectionPath', this.defaultConnectionPath());
      if (!await IOUtils.exists(file)) throw new Error('等待 DeepSeek Harness：请打开 Harness，并启用 Nature 精读配套插件。');
      const connection = JSON.parse(await IOUtils.readUTF8(file));
      if (connection.protocolVersion !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.url) || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error('Harness 连接文件格式不兼容，请更新配套插件。');
      return connection;
    }

    async request(method, path, body) {
      const connection = await this.connection();
      const response = await Zotero.HTTP.request(method, connection.url + path, {
        headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), responseType: 'json', timeout: 30000, successCodes: false
      });
      const data = typeof response.response === 'string' ? JSON.parse(response.response) : response.response;
      if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(data?.error || `Harness 请求失败（${response.status}）。`), { status: response.status });
      this.connected = true;
      return data;
    }

    activeReader(win = this.win) {
      return win.Zotero_Tabs?.selectedID && win.Zotero_Tabs.selectedID !== 'zotero-pane' ? Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) : null;
    }

    paper(reader) {
      const attachment = reader?._item || Zotero.Items.get(reader?.itemID);
      const parent = attachment?.parentItem;
      if (!attachment?.isPDFAttachment?.() || !parent?.isRegularItem?.()) throw new Error('请先打开一篇带父文献条目的 PDF。');
      const bridge = this.bridge();
      const paper = bridge.paperFromItem(parent, attachment);
      return { attachment, paper: clone(paper) };
    }

    async bindDocument(binding) {
      const { attachment, paper } = this.paper(binding.reader);
      const file = await attachment.getFilePathAsync();
      if (!file || !await IOUtils.exists(file)) throw new Error('该 PDF 尚未下载到本机，请先下载或打开附件。');
      const info = await IOUtils.stat(file), pdfStamp = `${info.size}:${info.lastModified}`;
      let snapshot;
      try { snapshot = await this.request('POST', '/paper/open', { paper, attachmentKey: attachment.key, pdfPath: file }); }
      catch (error) {
        this.connected = false;
        const cached = [...this.known.values()].find(item => item.paper?.libraryID === paper.libraryID && item.paper?.itemKey === paper.itemKey && item.snapshot?.attachmentKey === attachment.key && item.pdfStamp === pdfStamp && item.snapshot?.reading);
        if (!cached) throw error;
        snapshot = cached.snapshot; binding.notice = '正在阅读本地缓存；可以继续标注，连接恢复后可提问。';
      }
      binding.key = snapshot.key; binding.paper = paper; binding.error = '';
      await this.absorb(snapshot);
      binding.mode = this.known.get(binding.key)?.mode || 'pdf';
      binding.pdfPath = file; binding.pdfStamp = pdfStamp; binding.nextFileCheck = Date.now() + 15000;
      this.known.get(binding.key).pdfStamp = pdfStamp; await this.saveState();
      this.layout(binding);
      this.emit(binding);
      this.annotations.refreshSoon();
      return snapshot;
    }

    saveState() {
      const documents = [...this.known.values()].map(item => ({ key: item.key, paper: item.paper, remoteRevision: item.remoteRevision,
        busyChat: item.busyChat, busyReading: item.busyReading, archiveError: item.archiveError || '',
        archivedReading: item.archivedReading ?? -1, archivedChat: item.archivedChat || {}, position: item.position || null, mode: item.mode || 'pdf', pdfStamp: item.pdfStamp || '' }));
      const text = JSON.stringify({ version: 1, documents }, null, 2);
      const work = this.saveTail.catch(() => {}).then(() => IOUtils.writeUTF8(this.statePath, text, { tmpPath: this.statePath + '.tmp', flush: true }));
      this.saveTail = work;
      return work;
    }

    async absorb(snapshot) {
      const old = this.known.get(snapshot.key);
      if (old?.snapshot && old.snapshot.revision > snapshot.revision) return;
      const item = old || { key: snapshot.key, remoteRevision: -1 };
      if (old && JSON.stringify(old.paper) !== JSON.stringify(snapshot.paper)) { item.archivedReading = -1; item.archivedChat = {}; }
      item.paper = clone(snapshot.paper); item.snapshot = snapshot; item.busyChat = snapshot.busyChat; item.busyReading = snapshot.busyReading;
      this.known.set(item.key, item);
      await IOUtils.writeUTF8(PathUtils.join(this.directory, 'cache', item.key + '.json'), JSON.stringify(snapshot), { tmpPath: PathUtils.join(this.directory, 'cache', item.key + '.json.tmp') });
      let error = snapshot.readingOrderError || '';
      try {
        const bridge = this.bridge();
        if (snapshot.reading && snapshot.reading.revision !== item.archivedReading) {
          const result = await bridge.archiveReading({ paper: snapshot.paper, reading: snapshot.reading });
          if (!result.synced) error = result.error;
          else item.archivedReading = snapshot.reading.revision;
        }
        item.archivedChat ||= {};
        for (const record of snapshot.chat || []) {
          const stamp = `${record.updatedAt}:${record.status}:${record.answer.length}`;
          if (item.archivedChat[record.id] === stamp) continue;
          const result = await bridge.archiveExternal({ paper: snapshot.paper, record });
          if (!result.synced) error = result.error;
          else item.archivedChat[record.id] = stamp;
        }
        if (!error) item.remoteRevision = snapshot.revision;
        item.refresh = !!error;
      } catch (failure) { error = String(failure.message || failure); item.refresh = true; }
      item.archiveError = error;
      await this.saveState();
      for (const binding of this.bindings.values()) if (binding.key === item.key) this.emit(binding);
      this.annotations.refreshSoon();
    }

    async attach(reader) {
      if (this.bindings.has(reader)) return this.bindings.get(reader);
      const source = reader?._iframe;
      if (!source?.parentNode || !reader._item?.isPDFAttachment?.()) return null;
      const doc = source.ownerDocument, parent = source.parentNode;
      const binding = { reader, source, parent, key: null, paper: null, error: '', mode: 'pdf', collapsed: false,
        width: Services.prefs.getIntPref(PREF + 'sidebarWidth', 330), oldPosition: parent.style.position,
        oldMargin: source.style.marginInlineStart, oldVisibility: source.style.visibility, selected: null, loaded: false };
      parent.style.position = 'relative';
      const sidebar = doc.createXULElement('browser');
      sidebar.setAttribute('src', 'chrome://zotero-nature/content/panel.xhtml');
      sidebar.setAttribute('type', 'content');
      sidebar.style.cssText = 'position:absolute;top:0;bottom:0;left:0;z-index:8;min-width:0;';
      const handle = doc.createXULElement('box');
      handle.style.cssText = 'position:absolute;top:0;bottom:0;width:5px;z-index:9;cursor:col-resize;background:transparent;';
      const viewer = doc.createXULElement('browser');
      viewer.setAttribute('src', 'chrome://zotero-nature/content/reader.xhtml'); viewer.setAttribute('type', 'content');
      viewer.style.cssText = 'position:absolute;top:0;bottom:0;right:0;z-index:7;'; viewer.hidden = true;
      binding.sidebar = sidebar; binding.viewer = viewer; binding.handle = handle;
      const init = frame => {
        const ready = () => {
          if (frame.contentDocument?.documentURI?.startsWith('chrome://zotero-nature/')) {
            const target = frame.contentDocument;
            binding.eventDocument = target.documentURI;
            target.addEventListener('click', event => { binding.lastClick = event.target?.id || event.target?.localName; }, true, true);
            target.addEventListener('znr-action', event => {
              try {
                const message = JSON.parse(event.detail);
                binding.lastAction = message.action;
                this.safe(() => this.action(binding, message), binding);
              } catch (error) { this.log(error); }
            }, false, true);
            this.emit(binding);
          }
        };
        frame.addEventListener('DOMContentLoaded', ready, true);
        binding.cleanups.push(() => frame.removeEventListener('DOMContentLoaded', ready, true));
      };
      binding.cleanups = []; init(sidebar); init(viewer);
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        const start = event.screenX, width = binding.width;
        const move = move => { binding.width = Math.max(270, Math.min(540, width + move.screenX - start)); this.layout(binding); };
        const up = () => { doc.removeEventListener('pointermove', move, true); doc.removeEventListener('pointerup', up, true); Services.prefs.setIntPref(PREF + 'sidebarWidth', binding.width); };
        doc.addEventListener('pointermove', move, true); doc.addEventListener('pointerup', up, true);
      });
      parent.append(sidebar, handle, viewer);
      this.bindings.set(reader, binding);
      const resize = () => this.layout(binding);
      doc.defaultView.addEventListener('resize', resize);
      binding.cleanups.push(() => doc.defaultView.removeEventListener('resize', resize));
      this.layout(binding);
      try { await this.bindDocument(binding); }
      catch (error) { binding.error = String(error.message || error); this.emit(binding); }
      return binding;
    }

    layout(binding) {
      const viewDocument = binding.viewer.contentDocument;
      const preservePosition = !binding.viewer.hidden && binding.mode === 'bilingual' && viewDocument?.documentURI?.startsWith('chrome://zotero-nature/');
      if (preservePosition) viewDocument.dispatchEvent(new viewDocument.defaultView.CustomEvent('znr-before-layout'));
      const item = this.known.get(binding.key);
      if (item && item.mode !== binding.mode) { item.mode = binding.mode; this.safe(() => this.saveState()); }
      const width = binding.collapsed ? 0 : binding.width;
      const rect = binding.parent.getBoundingClientRect();
      const height = Math.max(100, rect.height);
      binding.sidebar.hidden = binding.collapsed; binding.handle.hidden = binding.collapsed;
      binding.sidebar.style.width = width + 'px'; binding.handle.style.left = (width - 3) + 'px';
      binding.sidebar.style.height = height + 'px'; binding.sidebar.setAttribute('width', String(width)); binding.sidebar.setAttribute('height', String(Math.round(height)));
      binding.viewer.style.width = Math.max(100, rect.width - width) + 'px'; binding.viewer.style.height = height + 'px';
      binding.viewer.setAttribute('width', String(Math.max(100, Math.round(rect.width - width)))); binding.viewer.setAttribute('height', String(Math.round(height)));
      binding.source.style.marginInlineStart = width + 'px';
      binding.source.style.visibility = binding.mode === 'bilingual' ? 'hidden' : binding.oldVisibility;
      binding.viewer.style.left = width + 'px'; binding.viewer.hidden = binding.mode !== 'bilingual';
      if (preservePosition) viewDocument.dispatchEvent(new viewDocument.defaultView.CustomEvent('znr-after-layout'));
    }

    emitDocument(frame, state) {
      const doc = frame.contentDocument;
      if (!doc?.documentURI?.startsWith('chrome://zotero-nature/')) return;
      doc.dispatchEvent(new doc.defaultView.CustomEvent('znr-state', { detail: JSON.stringify(state) }));
    }

    emit(binding, renderReader = true) {
      const item = this.known.get(binding.key);
      const snapshot = item?.snapshot;
      const reading = snapshot?.reading;
      this.emitDocument(binding.sidebar, { connected: this.connected, paper: binding.paper, mode: binding.mode, appearance: this.appearance(),
        error: binding.error || this.lastError, notice: binding.notice || '', archiveError: item?.archiveError || '', selected: binding.selected,
        key: binding.key, busyChat: snapshot?.busyChat || false, busyReading: snapshot?.busyReading || false,
        annotationStatus: binding.annotationStatus || '', panelCommand: binding.panelCommand || null,
        chat: snapshot?.chat || [], reading: reading ? { status: reading.status, totalBlocks: reading.totalBlocks,
          doneBlocks: reading.doneBlocks, guide: reading.guide, error: reading.error, notes: reading.notes,
          figureNotes: reading.blocks.filter(b => b.asset && ['figure', 'table'].includes(b.type)).map(b => ({ blockId: b.id, page: b.page, note: b.readingNote || null })) } : null });
      if (renderReader && binding.mode === 'bilingual') this.safe(() => this.emitReader(binding), binding);
    }

    async emitReader(binding) {
      const paperKey = binding.key;
      const snapshot = this.known.get(binding.key)?.snapshot;
      const reading = snapshot?.reading;
      const stamp = JSON.stringify([paperKey, reading?.revision, snapshot?.layout?.revision, snapshot?.layout?.status,
        this.annotations.rows.get(paperKey), this.appearance(), binding.annotationStatus, binding.error, binding.navigation, binding.collapsed, this.connected,
        snapshot?.chat, snapshot?.busyChat, this.known.get(paperKey)?.archiveError]);
      if (binding.readerStamp === stamp) return;
      const assets = {};
      for (const asset of reading?.assets || []) {
        if (!/\.png$/i.test(asset.name)) continue;
        const key = binding.key + ':' + asset.name;
        if (!this.assetCache.has(key) && await IOUtils.exists(asset.sourcePath)) this.assetCache.set(key, await Zotero.File.generateDataURI(asset.sourcePath, 'image/png'));
        assets[asset.name] = this.assetCache.get(key) || '';
      }
      const fonts = {};
      for (const font of snapshot?.layout?.fonts || []) {
        if (!font.available || !font.sourcePath || !['opentype', 'truetype'].includes(font.format)) continue;
        const key = binding.key + ':font:' + font.id;
        if (!this.assetCache.has(key) && await IOUtils.exists(font.sourcePath)) this.assetCache.set(key, await Zotero.File.generateDataURI(font.sourcePath, font.format === 'opentype' ? 'font/otf' : 'font/ttf'));
        fonts[font.id] = this.assetCache.get(key) || '';
      }
      if (!this.bindings.has(binding.reader) || binding.mode !== 'bilingual' || binding.key !== paperKey) return;
      if (binding.readerStamp === stamp) return;
      binding.readerStamp = stamp;
      const key = binding.key;
      this.emitDocument(binding.viewer, { key, paper: binding.paper, reading, assets, fonts, layout: snapshot?.layout || null,
        appearance: this.appearance(), position: this.known.get(key)?.position || null, annotations: this.annotations.rows.get(key) || [],
        canUndo: this.annotations.data.undo.some(row => row.paperKey === key), annotationStatus: binding.annotationStatus || '', error: binding.error || '',
        navigation: binding.navigation || null, sidebarCollapsed: binding.collapsed, connected: this.connected,
        chat: snapshot?.chat || [], busyChat: snapshot?.busyChat || false, archiveError: this.known.get(key)?.archiveError || '' });
    }

    appearance() {
      try { return JSON.parse(Services.prefs.getStringPref(PREF + 'appearance', '{}')); }
      catch { return {}; }
    }

    async action(binding, message) {
      binding.error = '';
      if (message.action === 'ready') { binding.readerStamp = ''; this.emit(binding); return; }
      if (message.action === 'appearance') {
        const patch = message.appearance || {}, value = this.appearance();
        for (const name of ['overviewExpanded', 'outlineOpen', 'fitWidth', 'showHighlights']) if (typeof patch[name] === 'boolean') value[name] = patch[name];
        if (['source', 'sans', 'serif'].includes(patch.fontFamily)) value.fontFamily = patch.fontFamily;
        if (['sans', 'serif'].includes(patch.chineseFont)) value.chineseFont = patch.chineseFont;
        if (['system', 'light', 'dark'].includes(patch.theme)) value.theme = patch.theme;
        if (Number.isFinite(patch.fontSize)) value.fontSize = Math.round(Math.max(15, Math.min(25, patch.fontSize)));
        if (Number.isFinite(patch.paperWidth)) value.paperWidth = Math.round(Math.max(800, Math.min(1600, patch.paperWidth)));
        if (Number.isFinite(patch.figureSplit)) value.figureSplit = Math.max(25, Math.min(75, patch.figureSplit));
        if (Number.isFinite(patch.figureFontSize)) value.figureFontSize = Math.round(Math.max(14, Math.min(24, patch.figureFontSize)));
        Services.prefs.setStringPref(PREF + 'appearance', JSON.stringify(value));
        for (const current of this.bindings.values()) this.emit(current);
        return;
      }
      if (message.action === 'position') {
        const item = this.known.get(binding.key), position = message.position;
        if (item && position && Number.isFinite(position.scrollTop) && position.scrollTop >= 0) {
          item.position = { scrollTop: position.scrollTop, blockId: /^[A-Z]\d+$/.test(position.blockId || '') ? position.blockId : '', offset: Number.isFinite(position.offset) ? position.offset : 0,
            anchorVersion: [2, 3].includes(position.anchorVersion) ? position.anchorVersion : 1, anchorHeight: Number.isFinite(position.anchorHeight) && position.anchorHeight > 0 ? position.anchorHeight : 0, expandedGroups: Array.isArray(position.expandedGroups) ? position.expandedGroups.filter(key => /^(graphic-[A-Z]\d+|authors-[A-Z]\d+|notes-\d+)$/.test(key)).slice(0, 300) : [] };
          await this.saveState();
        }
        return;
      }
      if (message.action === 'collapse') { binding.collapsed = true; this.layout(binding); return; }
      if (message.action === 'toggle-sidebar') { binding.collapsed = !binding.collapsed; this.layout(binding); this.emit(binding); return; }
      if (message.paperKey && message.paperKey !== binding.key) throw new Error('文献已切换，请重新操作。');
      if (message.action.startsWith('annotation-')) { binding.annotationStatus = '正在保存到 Zotero…'; this.emit(binding); }
      if (message.action === 'annotation-create') { await this.annotations.create(binding, message); return; }
      if (message.action === 'annotation-edit') { await this.annotations.edit(binding, message); return; }
      if (message.action === 'annotation-undo') { await this.annotations.undo(binding); return; }
      if (message.action === 'copy') { Components.classes['@mozilla.org/widget/clipboardhelper;1'].getService(Components.interfaces.nsIClipboardHelper).copyString(String(message.text || '')); return; }
      if (message.action === 'locate') {
        binding.mode = 'bilingual'; binding.navigation = { id: Date.now(), blockId: message.blockId, openFigure: !!message.openFigure };
        this.layout(binding); this.emit(binding); return;
      }
      if (message.action === 'reconnect') { await this.bindDocument(binding); return; }
      if (message.action === 'settings') { this.settings(binding.reader._window || this.win); return; }
      if (message.action === 'open-note') { await this.bridge().openNote(binding.reader._window || this.win); return; }
      if (message.action === 'mode') {
        binding.mode = message.mode === 'bilingual' ? 'bilingual' : 'pdf'; this.layout(binding); this.emit(binding); return;
      }
      if (message.action === 'source') {
        const blocks = this.known.get(binding.key)?.snapshot?.reading?.blocks || [];
        const block = blocks.find(block => block.id === message.blockId);
        const page = block?.page || Number(message.page);
        if (!Number.isInteger(page) || page < 1) return;
        binding.mode = 'pdf'; this.layout(binding);
        const snapshot = this.known.get(binding.key)?.snapshot;
        const rects = root.ZNRAnnotationCore.rectsFor(snapshot?.layout?.blocks?.[block?.id], message.start ?? 0, message.end ?? Infinity);
        await binding.reader.navigate(message.annotationKey ? { annotationID: message.annotationKey } : rects.length ? { position: { pageIndex: page - 1, rects } } : { pageIndex: page - 1 }); this.emit(binding); return;
      }
      if (message.action === 'selection') {
        binding.selected = message.selection || null;
        if (binding.selected) { binding.collapsed = false; binding.panelCommand = { id: Date.now(), tab: 'chat', prompt: message.intent === 'explain' ? '' : message.prompt || '', focus: message.intent !== 'explain' }; }
        this.layout(binding); this.emit(binding);
        if (message.intent === 'explain' && binding.selected) {
          binding.panelCommand = { id: Date.now(), tab: 'chat', prompt: '', focus: false };
          await this.action(binding, { action: 'chat', question: message.prompt || '请结合论文上下文解释我选中的内容，并标注来源。' });
        }
        return;
      }
      if (message.action === 'retry-layout') { await this.absorb(await this.request('POST', `/paper/${binding.key}/layout`, { retry: true })); return; }
      if (!binding.key) await this.bindDocument(binding);
      const key = binding.key, paper = clone(binding.paper);
      if (message.action === 'generate') {
        binding.notice = '';
        this.bridge();
        await this.absorb(await this.request('POST', `/paper/${key}/generate`, {}));
        binding.mode = 'bilingual'; this.layout(binding); this.emit(binding); return;
      }
      if (message.action === 'cancel') { await this.absorb(await this.request('POST', `/paper/${key}/cancel`, { kind: message.kind })); return; }
      if (message.action === 'chat') {
        const selected=Object.hasOwn(message,'selection')?message.selection:binding.selected;
        const id = message.id || Services.uuid.generateUUID().toString().replace(/[{}]/g, '');
        const previous = this.known.get(key)?.snapshot?.chat.find(item => item.id === id);
        const record = { source: 'dsh', id, question: String(message.question || previous?.question || '').trim(),
          answer: previous?.answer || '', status: 'pending', createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() };
        if (!record.question) return;
        if (!message.retry && selected?.kind === 'figure') {
          const label = `[${selected.blockId} p.${selected.page}] `;
          if (!record.question.startsWith(label)) record.question = label + record.question;
        }
        if(!message.retry&&selected?.origin&&selected.text){
          const label=selected.origin==='reading-note'?'AI 图表解读':selected.origin==='conversation'?(selected.recordRole==='user'?'先前提问':'AI 对话回答'):'论文图注';
          record.question+=`\n\n引用选段（${label}）：\n${String(selected.text).slice(0,15000)}`;
        }
        record.selection=clone(selected||previous?.selection||null);
        await this.bridge().archiveExternal({ paper, record });
        const local = this.known.get(key)?.snapshot;
        if (local) { local.chat = [...local.chat.filter(item => item.id !== id), record]; local.busyChat = true; this.emit(binding); }
        try { await this.absorb(await this.request('POST', `/paper/${key}/chat`, { id, question: record.question, selection: selected, retry: !!message.retry })); }
        catch (error) {
          Object.assign(record, { status: 'error', error: String(error.message || error), updatedAt: Date.now() });
          if (local) local.busyChat = false;
          await this.bridge().archiveExternal({ paper, record });
          throw error;
        }
        binding.selected = null; this.emit(binding);
      }
    }

    async togglePanel(reader = this.activeReader()) {
      if (!reader) throw new Error('请先打开一篇文献 PDF。');
      const existing = this.bindings.get(reader);
      const binding = existing || await this.attach(reader);
      if (existing) binding.collapsed = !binding.collapsed;
      this.layout(binding); this.emit(binding);
    }

    async tick() {
      if (this.stopped || this.ticking) return;
      this.ticking = true;
      try {
        for (const [reader, binding] of this.bindings) if (!binding.source.isConnected) this.detach(reader);
        for (const win of this.windows.keys()) {
          const reader = this.activeReader(win);
          if (reader && !this.bindings.has(reader)) await this.attach(reader);
        }
        for (const binding of this.bindings.values()) if (binding.pdfPath && Date.now() > binding.nextFileCheck && this.activeReader(binding.reader._window) === binding.reader) {
          binding.nextFileCheck = Date.now() + 15000;
          try {
            const info = await IOUtils.stat(binding.pdfPath), stamp = `${info.size}:${info.lastModified}`;
            if (stamp !== binding.pdfStamp) {
              const previous = binding.key; await this.bindDocument(binding);
              if (binding.key !== previous) binding.notice = 'PDF 文件已变化。点击“开始精读”生成新版，笔记中保留此前版本。';
            }
          } catch (error) { binding.error = String(error.message || error); }
        }
        try {
          const health = await this.request('GET', '/health');
          if (health.protocolVersion !== 1) throw new Error('Harness 配套插件协议不兼容。');
          this.lastError = '';
          const active = new Set([...this.bindings.values()].filter(binding => (!binding.collapsed || binding.mode === 'bilingual') && this.activeReader(binding.reader._window) === binding.reader).map(binding => binding.key));
          for (const item of [...this.known.values()]) {
            if (!item.refresh && !item.busyChat && !item.busyReading && !active.has(item.key)) continue;
            try {
              const snapshot = await this.request('GET', `/paper/${item.key}?revision=${item.refresh ? -1 : item.remoteRevision}`);
              if (!snapshot.unchanged) await this.absorb(snapshot);
            } catch (error) {
              const bound = [...this.bindings.values()].filter(binding => binding.key === item.key);
              if (error.status === 404) {
                this.known.delete(item.key);
                for (const binding of bound) { binding.key = null; this.safe(() => this.bindDocument(binding), binding); }
              } else for (const binding of bound) { binding.error = String(error.message || error); this.emit(binding, false); }
              Zotero.logError(error);
            }
          }
        } catch (error) { this.connected = false; this.lastError = String(error.message || error); }
        for (const binding of this.bindings.values()) {
          if (binding.annotationStatus?.includes('待同步')) {
            const note = Zotero.ObsidianLiteratureBridge?.store?.state?.notes?.[binding.paper?.libraryID + ':' + binding.paper?.itemKey];
            if (note && !note.dirty) binding.annotationStatus = '已同步到 Zotero 与 Obsidian';
          }
          this.emit(binding);
        }
        const status = { version: '0.2.9', connected: this.connected, documents: this.known.size, readers: this.bindings.size,
          lastError: this.lastError, layout: [...this.bindings.values()].map(binding => {
            const box = binding.sidebar.getBoundingClientRect(); return { width: box.width, height: box.height, x: box.x, y: box.y,
              panelReady: binding.sidebar.contentDocument?.documentElement?.getAttribute('data-panel-ready'),
              sent: binding.sidebar.contentDocument?.documentElement?.getAttribute('data-last-action'),
              received: binding.lastAction || '', click: binding.lastClick || '', eventDocument: binding.eventDocument || '' };
          }), updatedAt: new Date().toISOString() };
        const stamp = JSON.stringify({ ...status, updatedAt: '' });
        if (stamp !== this.previousStatus) { await IOUtils.writeUTF8(this.statusPath, JSON.stringify(status, null, 2), { tmpPath: this.statusPath + '.tmp' }); this.previousStatus = stamp; }
      } finally { this.ticking = false; }
    }

    log(error) { this.lastError = String(error?.message || error); Zotero.logError(new Error('[Nature 精读] ' + this.lastError)); }
    async safe(work, binding) {
      try { return await work(); }
      catch (error) { if (binding) { binding.error = String(error.message || error); this.emit(binding); } else this.log(error); }
    }

    settings(win) {
      const value = { value: Services.prefs.getStringPref(PREF + 'connectionPath', this.defaultConnectionPath()) };
      if (Services.prompt.prompt(win, 'Nature 精读 · Harness 连接', 'Harness 连接文件路径（请保留本机 connection.json）：', value, null, {})) {
        Services.prefs.setStringPref(PREF + 'connectionPath', value.value.trim());
        for (const item of this.known.values()) item.refresh = true;
        this.safe(() => this.tick());
      }
    }

    async addWindow(win) {
      if (this.windows.has(win)) return;
      const doc = win.document, popup = doc.getElementById('menu_ToolsPopup');
      const menu = doc.createXULElement('menu'); menu.setAttribute('label', 'Nature 精读 · DeepSeek Harness');
      const children = doc.createXULElement('menupopup');
      const actions = [
        ['展开 / 收起精读侧栏', () => this.togglePanel(this.activeReader(win))],
        ['开始 / 继续本篇精读', async () => { const binding = await this.attach(this.activeReader(win)); if (!binding) throw new Error('请先打开 PDF。'); await this.action(binding, { action: 'generate' }); }],
        ['切换原文 / 双语模式', async () => { const binding = await this.attach(this.activeReader(win)); if (!binding) throw new Error('请先打开 PDF。'); await this.action(binding, { action: 'mode', mode: binding.mode === 'pdf' ? 'bilingual' : 'pdf' }); }],
        ['Harness 连接设置', () => this.settings(win)]
      ];
      for (const [label, work] of actions) {
        const item = doc.createXULElement('menuitem'); item.setAttribute('label', label);
        item.addEventListener('command', () => this.safe(work)); children.append(item);
      }
      menu.append(children); popup?.append(menu); this.windows.set(win, () => menu.remove());
    }

    removeWindow(win) { this.windows.get(win)?.(); this.windows.delete(win); }
    detach(reader) {
      const binding = this.bindings.get(reader); if (!binding) return;
      for (const cleanup of binding.cleanups) cleanup();
      binding.sidebar.remove(); binding.viewer.remove(); binding.handle.remove();
      binding.source.style.marginInlineStart = binding.oldMargin; binding.source.style.visibility = binding.oldVisibility;
      binding.parent.style.position = binding.oldPosition; this.bindings.delete(reader);
    }

    async stop() {
      this.stopped = true; if (this.interval) this.win.clearInterval(this.interval);
      await this.annotations.stop();
      Zotero.Reader.unregisterEventListener('renderToolbar', this.readerListener);
      Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', this.selectionListener);
      for (const reader of [...this.bindings.keys()]) this.detach(reader);
      for (const win of [...this.windows.keys()]) this.removeWindow(win);
      await this.saveTail;
      if (Zotero.NatureReader === this) delete Zotero.NatureReader;
    }
  }
  root.ZNRRuntime = Runtime;
})(globalThis);
