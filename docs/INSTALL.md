# Windows 安装指南

## 1. 准备环境

- Zotero 10（清单也允许 11，未单独验收）。
- 一个现有 Obsidian 库，目录下应存在 `.obsidian`。
- 已配置默认模型的 DeepSeek Harness；需提供 agents、agentPresets、sessions、sessionPersistence、llm、attachments 服务。
- Node.js 22.19+、Python 3.11+，可在终端运行 `node --version` 与 `python --version`。

## 2. 安装两个 Zotero 插件

在 Zotero 的插件管理器中使用“从文件安装插件”，依次选择归档桥 `obsidian-literature-bridge-0.3.7.xpi` 与阅读插件 `zotero-nature-reader-0.2.13.xpi`。

通过 **工具 → Obsidian 文献笔记** 打开管理窗口，选择自己的库目录和笔记文件夹（默认相对文件夹 `文献阅读`）。发布版的库路径为空，必须先配置。

## 3. 配置 Python

源码目录需要保留在固定位置。打开该目录的 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-python.ps1
```

脚本仅在本项目的 `.venv` 内安装 PDF 依赖，不需要修改系统 Python 包。

## 4. 准备外部 Nature 技能

本项目不随包分发本机的 Nature 技能。请使用你已取得的、具备相应使用授权的技能目录。默认结构：

```text
%USERPROFILE%\.codex\skills\
  nature-reader\SKILL.md
  nature-reader\static\core\principles.md
  nature-reader\static\core\workflow.md
  nature-reader\static\core\output-contract.md
  nature-reader\static\fragments\source\pdf-text.md
  nature-reader\references\grounding-rules.md
  nature-shared\core\terminology-ledger.md
```

其他同目录 `nature-*` 技能可以一并被发现。自定义接入可通过 `backend/plugin.mjs` 的 `apply(ctx, config)` 配置 `skillRoot`、`python`、`workRoot`、`dshHome` 和 `agentPreset`，均是本机路径或配置值，不需要独立 API 密钥。

## 5. 接入 Harness

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-harness.ps1
```

脚本验证必要文件，备份并只更新自己的标记区块。默认 Desktop profile 位于 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`；其他路径使用 `-ProfilePath` 参数。随后重启 Harness。

需要完整退出 Harness 程序后再打开；只关闭窗口不会加载新版。请先等待正在运行的 Harness 任务结束，完整退出会中断它们。

本机连接文件由配套端自动生成在 `%USERPROFILE%\.dsh\zotero-nature\connection.json`，包含随机端口与凭据，由 Zotero 自动读取。该文件属于运行数据，不应提交到 Git。

## 6. 使用与更新

打开文献 PDF，使用阅读助手开始精读。再次打开读取已有结果；问答、图解与标注自动保存。首次生成内容会调用你配置的模型，可能消耗相应额度；演示模式不调用模型。

后续从 Releases 下载新版 XPI 手动更新。源码位置改变时重新运行 Harness 接入脚本。`work/` 是正文与生成进度缓存；Zotero 数据目录中的 `nature-reader/` 和 `obsidian-literature-bridge/` 保存定位、映射及归档状态，按自己的备份方案保留。

### 升级到 0.2.13

1. 备份现有源码目录中的 `work/`、Zotero 数据目录中的插件状态，以及 Obsidian 笔记库。
2. 将新版源码文件合并到原来的固定目录，保留已有 `work/`、`.venv/` 和本地配置。使用 Git 安装的用户可正常拉取更新。
3. 在 Zotero 更新阅读插件 0.2.13 和归档桥 0.3.7；已有 Obsidian 库路径继续沿用。
4. 重新运行 `scripts/install-harness.ps1`，等待其他任务结束后完整退出并重新打开 Harness；若 Zotero 提示重启则完成一次正常重启。
5. 打开已有文献，插件会在本地升级阅读顺序和续段结构，复用译文、指南和对话。可靠匹配的旧中文整段标注会备份后原位收窄；手动改过的原生标注不会自动移动。

中文高亮在双语页保持精确字符范围，PDF 高亮对应英文句子，不能视为中英逐字对齐。无法可靠匹配时在 PDF 保存定位批注；保存窗口会提示该情况。

常见情况：

- 未连接：检查 Harness 已启动、默认模型有效、配套插件加载成功。
- 缺少 Nature 文件：按上面的资源列表检查外部技能目录。
- Obsidian 待同步：检查库目录可用、`.obsidian` 存在、笔记管理区标记完整。
- 扫描 PDF 无正文：先完成 OCR；首版不内置 OCR。
- 模型不支持图像：系统会说明仅依据图注与正文；不声称看过图片。
