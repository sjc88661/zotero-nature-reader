(function (root) {
  "use strict";
  const PaperMetadata = typeof module !== "undefined" && module.exports ? require("./paper-metadata.js") : root.PaperMetadata;

  const REGION_NAMES = ["info", "annotations", "summary", "discussions", "nature"];
  const marker = (name, edge) => `<!-- zob:${name}:${edge} -->`;
  const escapeMarkers = text => String(text || "").replace(/<!--\s*zob:[\s\S]*?-->/g, value => value.replace("<", "&lt;").replace(">", "&gt;"));
  const yaml = value => JSON.stringify(value);

  function paperId(paper) {
    if (!Number.isInteger(paper.libraryID) || !/^[A-Z0-9]{8}$/.test(paper.itemKey)) {
      throw new Error("文献缺少有效的 Zotero libraryID 或条目 key。");
    }
    return `${paper.libraryID}:${paper.itemKey}`;
  }

  function cleanName(value, length) {
    const text = String(value || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim();
    return Array.from(text).slice(0, length).join("").replace(/[. ]+$/g, "");
  }

  function filename(paper) {
    paperId(paper);
    return `${cleanName(paper.year || "年份未知", 8)} - ${cleanName(paper.firstAuthor || "作者未知", 24)} - ${cleanName(paper.title || "未命名文献", 80)} - [${paper.libraryID}-${paper.itemKey}].md`;
  }

  function relativeFolder(value) {
    const folder = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/g, "");
    if (!folder || /^[a-z]:|^\//i.test(folder) || folder.split("/").some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error("笔记文件夹须为库内相对路径，例如“文献阅读”，不能包含 .. 或文件名非法字符。");
    }
    return folder;
  }

  function noteIdentity(text) {
    const match = String(text).replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    return match?.[1].match(/^zotero_bridge_id: "(\d+:[A-Z0-9]{8})"\s*$/m)?.[1] || null;
  }

  function links(paper) {
    const prefix = paper.groupID ? `groups/${Number(paper.groupID)}` : "library";
    const result = [`[在 Zotero 中定位](zotero://select/${prefix}/items/${paper.itemKey})`];
    if (paper.attachmentKey && /^[A-Z0-9]{8}$/.test(paper.attachmentKey)) {
      result.push(`[打开 PDF](zotero://open-pdf/${prefix}/items/${paper.attachmentKey})`);
    }
    const doi = String(paper.doi || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
    if (doi) result.push(`[DOI](https://doi.org/${encodeURIComponent(doi)})`);
    return result.join(" · ");
  }

  function displayTime(value) {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(Number(value) || 0));
  }

  function anchor(id) {
    // Stable references are separate from the full, collision-free record IDs used for upserts.
    let hash = 14695981039346656037n;
    for (const character of String(id)) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 1099511628211n);
    return `zob-${hash.toString(16)}`;
  }

  function orderedRecords(records) {
    return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  function transcript(records) {
    if (!records.length) return "尚无已归档讨论。";
    const statuses = { pending: "等待回答", streaming: "正在回答", complete: "已完成", interrupted: "已中断", error: "出错" };
    return orderedRecords(records).map((record, index) => {
      const source = record.source === "dsh" ? "DeepSeek Harness" : "Awesome GPT";
      const status = record.status || "complete";
      return `### 讨论 ${index + 1} · ${displayTime(record.createdAt)}\n\n**来源：** ${source} · **状态：** ${statuses[status] || status}（${status}）\n\n**我：**\n\n${escapeMarkers(record.question) || "（这条历史记录未保存提问）"}\n\n**AI：**\n\n${escapeMarkers(record.answer) || "（回答尚未生成）"}${record.error ? `\n\n**错误：** ${escapeMarkers(record.error)}` : ""}\n\n^${anchor(record.id)}`;
    }).join("\n\n---\n\n");
  }

  function readingAnchor(readingId, blockId) {
    return `zob-nature-${anchor(`${readingId}:${blockId}`).slice(4)}`;
  }

  function natureText(paper, readings) {
    if (!readings.length) return "尚无双语精读。启动配套 Nature 精读后，全文原文、中文与导读将自动保存在这里。";
    const statuses = { extracting: "正在提取", translating: "正在翻译", complete: "已完成", interrupted: "已中断", error: "出错" };
    const types = { heading: "标题", paragraph: "段落", caption: "图表说明", figure: "图片", table: "表格", equation: "公式", note: "说明" };
    const prefix = paper.groupID ? `groups/${Number(paper.groupID)}` : "library";
    return [...readings].sort((a, b) => a.id.localeCompare(b.id)).map(reading => {
      const blocks = [...reading.blocks].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const byId = new Map(blocks.map(block => [block.id, block]));
      const sourceLink = id => {
        const block = byId.get(id);
        return block ? `[[#^${readingAnchor(reading.id, id)}|第 ${block.page} 页 · ${types[block.type]}]]` : `未定位原文（${escapeMarkers(id)}）`;
      };
      const lines = [
        `### ${escapeMarkers(reading.title || "PDF 精读").replace(/[\r\n]/g, " ")} · ${reading.attachmentKey} · ${reading.fingerprint.slice(0, 12)}`,
        `**状态：** ${statuses[reading.status]}（${reading.status}） · ${reading.doneBlocks}/${reading.totalBlocks} 块已完成 · 修订 ${reading.revision}`,
        `**源文版本：** \`${reading.id}\` · 更新于 ${displayTime(reading.updatedAt)}`
      ];
      if (reading.status !== "complete" || reading.doneBlocks < reading.totalBlocks) lines.push("**全文尚未完成；以下保留已提取的原文与已完成的翻译。**");
      if (reading.error) lines.push(`**错误：** ${escapeMarkers(reading.error)}`);
      if (reading.notes?.length) lines.push(reading.notes.map(note => `> ${escapeMarkers(note).replace(/\r?\n/g, "\n> ")}`).join("\n"));
      if (reading.sourceMapLink) lines.push(`[[${reading.sourceMapLink}|源文定位映射（source_map.json）]]`);
      const guide = reading.guide;
      if (guide) {
        lines.push("#### Nature 阅读导引");
        if (guide.overview) lines.push(escapeMarkers(guide.overview));
        if (guide.readingOrder?.length) lines.push("**建议阅读顺序**", guide.readingOrder.map((id, index) => `${index + 1}. ${byId.has(id) ? sourceLink(id) : escapeMarkers(id)}`).join("\n"));
        const categories = new Map();
        for (const highlight of guide.highlights || []) {
          const category = highlight.category || "重点";
          if (!categories.has(category)) categories.set(category, []);
          categories.get(category).push(highlight);
        }
        for (const [category, highlights] of categories) {
          lines.push(`##### ${escapeMarkers(category).replace(/[\r\n]/g, " ")}`);
          for (const highlight of highlights) {
            lines.push(sourceLink(highlight.blockId));
            if (highlight.original) lines.push(`**原文：** ${escapeMarkers(highlight.original)}`);
            if (highlight.translation) lines.push(`**中文：** ${escapeMarkers(highlight.translation)}`);
            if (highlight.explanation) lines.push(`**解读：** ${escapeMarkers(highlight.explanation)}`);
          }
        }
        if (guide.glossary?.length) {
          const cell = value => escapeMarkers(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
          lines.push("**术语表**", "| 原文术语 | 中文 | 说明 |\n| --- | --- | --- |\n" + guide.glossary.map(row => `| ${cell(row.term)} | ${cell(row.translation)} | ${cell(row.note || "")} |`).join("\n"));
        }
      }
      lines.push("#### 全文双语对照");
      const metadata = PaperMetadata.classify(blocks, paper.title, paper.authors);
      const metadataIds = new Set(metadata.ids);
      const captionOwners = new Map();
      for (const block of blocks) if (block.asset) for (const id of block.captionIds || []) if (byId.get(id)?.type === "caption") captionOwners.set(id, block.id);
      const renderBlock = block => {
        const imageOnly = block.asset && ["figure", "table", "equation"].includes(block.type)
          && !String(block.original || "").trim() && !String(block.translation || "").trim();
        const blockLines = [
          `##### ${types[block.type]} · 第 ${block.page} 页${block.status === "pending" && !imageOnly ? " · 待翻译" : ""}`,
          `[打开 PDF 第 ${block.page} 页](zotero://open-pdf/${prefix}/items/${reading.attachmentKey}?page=${block.page})`
        ];
        if (block.asset && reading.assetPaths?.[block.asset]) blockLines.push(`![[${reading.assetPaths[block.asset]}]]`);
        if (imageOnly) blockLines.push(block.captionIds?.length ? "**完整原图** · 双语图注见下方。" : "**原图说明**\n\n此块未提取文字，以原图保留；请结合对应图注或原文说明阅读。");
        else {
          blockLines.push(`**原文**\n\n${escapeMarkers(block.original) || "（此块无可提取文字，请查看原文或图片）"}`);
          blockLines.push(`**中文**\n\n${escapeMarkers(block.translation) || "（待翻译）"}`);
        }
        if (block.confidence) blockLines.push(`**提取提示：** ${escapeMarkers(block.confidence)}`);
        blockLines.push(`^${readingAnchor(reading.id, block.id)}`);
        return blockLines.join("\n\n");
      };
      const renderMetadata = () => {
        if (metadata.ids.length) lines.push("> [!info]- 作者、单位与通讯信息\n" + metadata.ids
          .map(id => renderBlock(byId.get(id))).join("\n\n").split("\n").map(line => "> " + line).join("\n"));
      };
      if (!metadata.titleId) renderMetadata();
      for (const block of blocks) {
        if (captionOwners.has(block.id) || metadataIds.has(block.id)) continue;
        if (block.visualParentId) {
          lines.push(`原图分面 ${escapeMarkers(block.id)} 已合并至 ${sourceLink(block.visualParentId)}。\n\n^${readingAnchor(reading.id, block.id)}`);
          continue;
        }
        lines.push(renderBlock(block));
        if (block.id === metadata.titleId) renderMetadata();
        for (const id of block.captionIds || []) if (byId.get(id)?.type === "caption") lines.push(renderBlock(byId.get(id)));
        if (block.readingNote?.text) lines.push(`**图表阅读提示** · ${block.readingNote.mode === "image" ? "依据原图、图注与正文" : "仅依据图注与正文，未查看实际图像"}\n\n${escapeMarkers(block.readingNote.text)}`);
      }
      return lines.join("\n\n");
    }).join("\n\n---\n\n");
  }

  function annotationText(paper, annotations) {
    if (annotations === null) return "尚未同步标注。可在 Zotero 中点击“同步本篇文献标注”。";
    if (!annotations.length) return "这篇文献当前没有 Zotero PDF 标注。";
    const types = { highlight: "高亮", underline: "下划线", note: "批注", text: "文本", image: "截图", ink: "手绘" };
    const prefix = paper.groupID ? `groups/${Number(paper.groupID)}` : "library";
    return [...annotations].sort((a, b) => a.attachmentKey.localeCompare(b.attachmentKey) || a.sortIndex.localeCompare(b.sortIndex) || a.key.localeCompare(b.key)).map(annotation => {
      const page = Number.isInteger(annotation.pageIndex) ? `page=${annotation.pageIndex + 1}&` : "";
      const link = `zotero://open-pdf/${prefix}/items/${annotation.attachmentKey}?${page}annotation=${annotation.key}`;
      const label = String(annotation.pageLabel || (Number.isInteger(annotation.pageIndex) ? annotation.pageIndex + 1 : "未知")).replace(/[\r\n]/g, " ");
      const lines = [
        `### ${types[annotation.type] || "标注"} · 第 ${escapeMarkers(label)} 页`,
        `[回到原文标注](${link}) · ${escapeMarkers(annotation.attachmentTitle || "PDF")}`
      ];
      if (annotation.text) lines.push(escapeMarkers(annotation.text).split(/\r?\n/).map(line => `> ${line}`).join("\n"));
      if (annotation.imagePath) lines.push(`![[${annotation.imagePath}]]`);
      else if (["image", "ink"].includes(annotation.type)) lines.push("（标注图片尚不可用，可先回到原文查看，PDF 下载后再次同步。）");
      if (annotation.comment) lines.push(`**批注：**\n\n${escapeMarkers(annotation.comment)}`);
      if (annotation.tags?.length) lines.push(`**标签：** ${escapeMarkers(annotation.tags.join("、"))}`);
      if (annotation.color) lines.push(`**颜色：** ${escapeMarkers(annotation.color)}`);
      lines.push(`^zob-annotation-${paper.libraryID}-${annotation.key}`);
      return lines.join("\n\n");
    }).join("\n\n---\n\n");
  }

  function info(paper) {
    return [
      `**标题：** ${escapeMarkers(paper.title)}`,
      `**作者：** ${escapeMarkers((paper.authors || []).join("；")) || "未填写"}`,
      `**年份：** ${escapeMarkers(paper.year) || "未填写"}`,
      `**期刊：** ${escapeMarkers(paper.journal) || "未填写"}`,
      `**DOI：** ${escapeMarkers(paper.doi) || "未填写"}`,
      "", links(paper)
    ].join("\n\n");
  }

  function regionBounds(text, name) {
    const begin = marker(name, "start");
    const end = marker(name, "end");
    const from = text.indexOf(begin);
    const to = text.indexOf(end);
    if (from < 0 || to <= from || text.indexOf(begin, from + begin.length) >= 0 || text.indexOf(end, to + end.length) >= 0) {
      throw new Error(`笔记的 ${name} 管理区标记缺失或重复，已停止覆盖；请先恢复标记。`);
    }
    return { from, to, contentStart: from + begin.length, afterEnd: to + end.length };
  }

  function validateRegions(text) {
    const regions = REGION_NAMES.map(name => ({ name, ...regionBounds(text, name) })).sort((a, b) => a.from - b.from);
    for (let index = 1; index < regions.length; index++) {
      if (regions[index].from < regions[index - 1].afterEnd) {
        throw new Error(`笔记的 ${regions[index - 1].name} 与 ${regions[index].name} 管理区标记重叠，已停止覆盖；请先恢复标记。`);
      }
    }
  }

  function replaceRegion(text, name, content) {
    const { contentStart, to } = regionBounds(text, name);
    return text.slice(0, contentStart) + "\n\n" + content + "\n\n" + text.slice(to);
  }

  function mergeNote(existing, paper, records, summaries = [], annotations = null, allowAnnotationMigration = true, readings = [], allowReadingMigration = true) {
    const identity = paperId(paper);
    let text = existing;
    if (text === null || text === undefined) {
      text = [
        "---", `zotero_bridge_id: ${yaml(identity)}`, `zotero_library_id: ${paper.libraryID}`, `zotero_item_key: ${yaml(paper.itemKey)}`,
        `title: ${yaml(paper.title)}`, `authors: ${yaml(paper.authors || [])}`, `year: ${yaml(paper.year || "")}`, `doi: ${yaml(paper.doi || "")}`,
        "tags: [文献阅读]", "---", "", `# ${String(paper.title || "未命名文献").replace(/[\r\n]/g, " ")}`, "",
        "## 文献信息", "", marker("info", "start"), marker("info", "end"), "",
        "## 个人整理", "", "在这里记录你的理解、疑问和研究想法。此区域由你自由编辑。", "",
        "## Zotero 标注", "", marker("annotations", "start"), marker("annotations", "end"), "",
        "## AI 整理", "", marker("summary", "start"), marker("summary", "end"), "",
        "## 完整讨论记录", "", marker("discussions", "start"), marker("discussions", "end"), "",
        "## Nature 双语精读", "", marker("nature", "start"), marker("nature", "end"), ""
      ].join("\n");
    } else if (noteIdentity(text) !== identity) {
      throw new Error("笔记的文献标识不匹配，已停止写入以保留原文件。");
    }
    // Older notes gain a new region once, without moving or changing their existing content.
    if (allowAnnotationMigration && !text.includes(marker("annotations", "start")) && !text.includes(marker("annotations", "end"))) {
      text += `\n\n## Zotero 标注\n\n${marker("annotations", "start")}\n${marker("annotations", "end")}\n`;
    }
    if (allowReadingMigration && !text.includes(marker("nature", "start")) && !text.includes(marker("nature", "end"))) {
      text += `\n\n## Nature 双语精读\n\n${marker("nature", "start")}\n${marker("nature", "end")}\n`;
    }
    validateRegions(text);
    // Preserve all bytes outside managed regions, including custom frontmatter and personal writing.
    const contents = {
      info: info(paper),
      annotations: annotationText(paper, annotations),
      summary: summaries.length ? [...summaries].sort((a, b) => b.createdAt - a.createdAt).map(summary => `### ${displayTime(summary.createdAt)} · AI 整理稿\n\n${escapeMarkers(summary.content)}`).join("\n\n---\n\n") : "尚未生成整理稿。可在 Zotero 的“Obsidian 文献笔记”菜单中按需整理。",
      discussions: transcript(records),
      nature: natureText(paper, readings)
    };
    for (const name of REGION_NAMES) text = replaceRegion(text, name, contents[name]);
    return text;
  }

  function normalizeRecord(record) {
    if (!record?.id) throw new Error("讨论记录缺少稳定 ID。");
    return {
      id: String(record.id).startsWith("overlay:") ? String(record.id) : `overlay:${record.id}`,
      question: String(record.question ?? record.inputText ?? ""),
      answer: String(record.answer ?? record.outputText ?? ""),
      createdAt: Number(record.createdAt) || Date.now(),
      updatedAt: Number(record.updatedAt) || Date.now()
    };
  }

  function normalizeExternalRecord(record) {
    if (record?.source !== "dsh" || !String(record.id || "").trim()) throw new Error("外部讨论须包含 source=dsh 和稳定 ID。");
    if (!["pending", "streaming", "complete", "interrupted", "error"].includes(record.status)) throw new Error("外部讨论状态无效。");
    const timestamp = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : Date.now();
    return {
      source: "dsh", id: String(record.id).startsWith("dsh:") ? String(record.id) : `dsh:${record.id}`,
      question: String(record.question ?? ""), answer: String(record.answer ?? ""), status: record.status,
      createdAt: timestamp(record.createdAt), updatedAt: timestamp(record.updatedAt),
      ...(record.error ? { error: String(record.error) } : {})
    };
  }

  function normalizeReading(raw) {
    const reading = structuredClone(raw);
    if (!reading || !/^[A-Z0-9]{8}$/.test(reading.attachmentKey) || !/^[a-f0-9]{64}$/.test(reading.fingerprint)
      || reading.id !== `${reading.attachmentKey}:${reading.fingerprint}`) throw new Error("精读缺少有效附件 key、SHA-256 或稳定 ID。");
    if (!["extracting", "translating", "complete", "interrupted", "error"].includes(reading.status)
      || !Number.isInteger(reading.revision) || reading.revision < 0 || !Number.isFinite(reading.updatedAt)) throw new Error("精读状态、修订号或更新时间无效。");
    if (!Number.isInteger(reading.totalBlocks) || !Number.isInteger(reading.doneBlocks) || reading.doneBlocks < 0 || reading.totalBlocks < reading.doneBlocks
      || !Array.isArray(reading.blocks) || !Array.isArray(reading.assets)) throw new Error("精读块或进度格式无效。");
    const absoluteSource = value => {
      if (typeof value !== "string" || !/^(?:[a-z]:[\\/]|\/|\\\\[^\\]+\\)/i.test(value) || /\x00/.test(value)) throw new Error("精读资产来源须为本地绝对路径。");
      return value;
    };
    const assetNames = new Set();
    const assetKeys = new Set();
    reading.assets = reading.assets.map(asset => {
      const name = relativeFolder(asset.name);
      const key = name.toLowerCase();
      if (assetKeys.has(key)) throw new Error("精读资产路径重复。");
      assetKeys.add(key);
      assetNames.add(name);
      return { name, sourcePath: absoluteSource(asset.sourcePath) };
    });
    if (reading.sourceMapPath) reading.sourceMapPath = absoluteSource(reading.sourceMapPath);
    const blockIds = new Set();
    reading.blocks = reading.blocks.map(block => {
      if (!block || typeof block.id !== "string" || !block.id || blockIds.has(block.id) || !Number.isInteger(block.page) || block.page < 1
        || !["heading", "paragraph", "caption", "figure", "table", "equation", "note"].includes(block.type) || !Number.isFinite(block.order)
        || typeof block.original !== "string" || typeof block.translation !== "string" || (block.status && !["pending", "complete"].includes(block.status))) throw new Error("精读原文块格式无效。");
      blockIds.add(block.id);
      if (block.asset) {
        block.asset = relativeFolder(block.asset);
        if (!assetNames.has(block.asset)) throw new Error("精读原文块引用了未登记的资产。");
      }
      if (block.bbox && (!Array.isArray(block.bbox) || block.bbox.length !== 4 || !block.bbox.every(Number.isFinite))) throw new Error("精读原文块坐标无效。");
      if (block.readingNote != null && (!block.asset || typeof block.readingNote !== "object" || block.readingNote.status !== "complete"
        || typeof block.readingNote.text !== "string" || !["image", "caption"].includes(block.readingNote.mode))) throw new Error("图表阅读提示格式无效。");
      return block;
    });
    const blockMap = new Map(reading.blocks.map(block => [block.id, block]));
    for (const block of reading.blocks) {
      if (block.captionIds !== undefined && (!block.asset || !Array.isArray(block.captionIds)
        || new Set(block.captionIds).size !== block.captionIds.length || block.captionIds.some(id => blockMap.get(id)?.type !== "caption" || blockMap.get(id).page !== block.page))) throw new Error("图注关联缺少同页的有效来源。");
      if (block.visualParentId !== undefined && (!blockMap.get(block.visualParentId)?.asset
        || blockMap.get(block.visualParentId).visualParentId || blockMap.get(block.visualParentId).page !== block.page
        || block.visualParentId === block.id || block.original || block.translation || block.asset)) throw new Error("图表分面合并关系无效。");
    }
    if (reading.guide != null && (typeof reading.guide !== "object" || Array.isArray(reading.guide))) throw new Error("精读导读格式无效。");
    if (reading.guide) {
      const guide = reading.guide;
      const stringField = (object, field, required = false) => {
        if ((required || object[field] !== undefined) && typeof object[field] !== "string") throw new Error(`精读导读的 ${field} 须为文本。`);
      };
      stringField(guide, "overview");
      for (const field of ["readingOrder", "highlights", "glossary"]) {
        if (guide[field] !== undefined && !Array.isArray(guide[field])) throw new Error(`精读导读的 ${field} 须为列表。`);
      }
      if (guide.readingOrder?.some(value => typeof value !== "string")) throw new Error("精读导读的阅读顺序须为文本列表。");
      const entry = (value, required, optional) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("精读导读条目须为对象。");
        for (const field of required) stringField(value, field, true);
        for (const field of optional) stringField(value, field);
      };
      for (const highlight of guide.highlights || []) entry(highlight, ["category", "blockId"], ["original", "translation", "explanation"]);
      for (const term of guide.glossary || []) entry(term, ["term", "translation"], ["note"]);
    }
    if (reading.notes != null && !Array.isArray(reading.notes)) throw new Error("精读说明须为列表。");
    return reading;
  }

  function summaryChunks(paper, records, limit = 16000) {
    const text = orderedRecords(records).map((record, index) => `[讨论 ${index + 1}；引用 [[#^${anchor(record.id)}|讨论 ${index + 1}]]]\n提问：${record.question}\n回答：${record.answer}`).join("\n\n");
    const chunks = [];
    for (let offset = 0; offset < text.length; offset += limit) chunks.push(text.slice(offset, offset + limit));
    return chunks;
  }

  const api = { paperId, filename, relativeFolder, noteIdentity, links, displayTime, anchor, readingAnchor, orderedRecords, transcript, mergeNote, normalizeRecord, normalizeExternalRecord, normalizeReading, summaryChunks };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ZOBCore = api;
})(globalThis);
