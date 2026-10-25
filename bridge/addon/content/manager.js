"use strict";

window.addEventListener("DOMContentLoaded", () => {
  const { bridge, mainWindow } = window.arguments[0];
  const $ = id => document.getElementById(id);
  const element = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
  const message = (text, error = false) => { $("message").textContent = text; $("message").classList.toggle("error", error); };
  let shownPaperId = null;
  let summaryPaperId = null;
  const identity = paper => paper ? `${paper.libraryID}:${paper.itemKey}` : null;

  function assertSamePaper() {
    if (!shownPaperId || identity(bridge.currentPaper(mainWindow)) !== shownPaperId) throw new Error("Zotero 中的文献已切换，请先点击“刷新当前文献”，确认导入目标。");
  }

  async function refresh() {
    const settings = bridge.settings();
    $("vault").value = settings.vaultPath;
    $("folder").value = settings.folder;
    const paper = bridge.currentPaper(mainWindow);
    shownPaperId = identity(paper);
    $("paper").textContent = paper ? paper.title : "请在 Zotero 中选中一篇文献或打开 PDF，再刷新。";
    const status = bridge.getStatus();
    $("status").textContent = `${status.connected ? "已连接 Awesome GPT 浮动聊天" : "等待 Awesome GPT 浮动聊天接口"} · 已归档 ${status.records} 条讨论、${status.annotations} 条标注 · ${status.pendingNotes} 篇笔记 / ${status.pendingAnnotations} 篇标注待同步${status.lastError ? " · " + status.lastError : ""}`;
    $("history").replaceChildren();
    const records = await bridge.history(mainWindow);
    if (!records.length) $("history").textContent = "暂无待导入的历史讨论或未关联记录。";
    for (const record of records) {
      const div = element("div");
      div.className = "record";
      const label = element("label");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.value = record.id;
      const span = element("span");
      span.textContent = (record.question || "（历史记录未保存提问）").slice(0, 180);
      label.append(checkbox, span);
      const details = element("details");
      const summary = element("summary");
      summary.textContent = "查看完整讨论";
      const preview = element("pre");
      preview.textContent = `我：${record.question}\n\nAI：${record.answer}`;
      details.append(summary, preview);
      div.append(label, details);
      $("history").append(div);
    }
  }

  function handle(id, work) {
    $(id).addEventListener("click", async () => {
      $(id).disabled = true;
      try { await work(); }
      catch (error) { message(String(error.message || error), true); }
      finally { $(id).disabled = false; }
    });
  }

  handle("refresh", refresh);
  handle("open", async () => { assertSamePaper(); await bridge.openNote(mainWindow); message("已打开对应的 Obsidian 文献笔记。"); });
  handle("annotations", async () => {
    assertSamePaper();
    const result = await bridge.syncAnnotations(mainWindow);
    await refresh();
    message(`已同步本篇文献的 ${result.count} 条标注。`);
  });
  handle("save", async () => { await bridge.saveSettings($("vault").value, $("folder").value); message("保存位置已更新。"); await refresh(); });
  handle("retry", async () => { await bridge.annotations.flush(); await bridge.store.retry(); await bridge.writeStatus(); await refresh(); message("已重试待同步笔记，剩余问题会显示在连接状态中。"); });
  handle("import", async () => {
    assertSamePaper();
    const selected = [...$("history").querySelectorAll('input[type="checkbox"]:checked')].map(checkbox => checkbox.value);
    const result = await bridge.importHistory(mainWindow, selected);
    await refresh();
    message(`已归档 ${result.imported} 条讨论。`);
  });
  handle("select-all", () => {
    const boxes = [...$("history").querySelectorAll('input[type="checkbox"]')];
    const checked = !boxes.every(box => box.checked);
    for (const box of boxes) box.checked = checked;
  });
  handle("summarize", async () => {
    assertSamePaper();
    summaryPaperId = shownPaperId;
    $("cancel").disabled = false;
    try { await bridge.summarize(mainWindow, text => message(text)); }
    finally { $("cancel").disabled = true; summaryPaperId = null; await refresh(); }
  });
  handle("cancel", () => {
    const job = bridge.jobs.get(summaryPaperId);
    if (job) { job.cancelled = true; job.xhr?.abort(); message("正在取消整理，已有笔记将保留。"); }
  });
  refresh().catch(error => message(String(error.message || error), true));
});
